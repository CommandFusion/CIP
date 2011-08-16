/*	

CIP

Version:
	1.1 - Cleanup, fix connectivity issues, and serial echo issue
	1.0 - release
		Supports standard XPanel features, with addition of serial transmit to control system.
		Currently does not support Password protection, List protocol, and other custom messages such as Orientation.
Use:
	Please visit http://www.github.com/CommandFusion/CIP for latest versions and help.

*/



//userMain
CF.userMain = function() {
	//Setup CIP instances in our Global Token Callback function for simplicity in passing those values to each system
	CF.getJoin(CF.GlobalTokensJoin, function(j, v, tokens) {
		var systems = tokens["CIP_System_Names"].split(",");
		for (var sys in systems) {
			CF.log("Initializing " + systems[sys] + "...");
			new CIP({
				systemName: 		systems[sys],
				IPID:				tokens[systems[sys] + ":IP_ID"],
				systemFeedbackName:	tokens[systems[sys] + ":Feedback_Name"],
				DJoin_connectedFB:	tokens[systems[sys] + ":Online_Digital_Join"],
				DJoin_Low:			tokens[systems[sys] + ":Digital_Low"],
				DJoin_High:			tokens[systems[sys] + ":Digital_High"],
				AJoin_Low:			tokens[systems[sys] + ":Analog_Low"],
				AJoin_High:			tokens[systems[sys] + ":Analog_High"],
				SJoin_Low:			tokens[systems[sys] + ":Serial_Low"],
				SJoin_High:			tokens[systems[sys] + ":Serial_High"]
			});
		}
	});
};


//CIP object
var CIP = function(params){

	//Instance reference
	var self = 					this;
	
	//Version of this module = versionMajor.versionMinor
	self.version =				"1.1";

	//Parameters
	self.IPID =						params["IPID"] 							|| "03";
	self.systemName =				params["systemName"] 					|| "Crestron";
	self.systemFeedbackName =		params["systemFeedbackName"] 			|| "Incoming_Data";
	self.DJoin_connectedFB =		parseInt(params["DJoin_connectedFB"]) 	|| 5000;
	self.DJoin_Low =				parseInt(params["DJoin_Low"]) 			|| 1;
	self.DJoin_High =				parseInt(params["DJoin_High"]) 			|| 1000;
	self.AJoin_Low =				parseInt(params["AJoin_Low"]) 			|| 1;
	self.AJoin_High =				parseInt(params["AJoin_High"]) 			|| 500;
	self.SJoin_Low =				parseInt(params["SJoin_Low"]) 			|| 1;
	self.SJoin_High =				parseInt(params["SJoin_High"]) 			|| 500;
	
	//Timers/debouncing
	self.heartBeatRate =			5000;	//1000 = 1s
	self.heartBeatTimer =			null;
	self.HoldJoins =				[];	//Array to hold joins that are being repeated
	self.HoldRepeatTimer =			500;	//Repeat at least every .5 seconds or control system releases digital.
		
	//Data receive buffer
	self.ourData = 					"";
	
	//Arrays that represent our joins
	self.DJoins =					[];
	self.AJoins =					[];
	self.SJoins =					[];
	self.ClearJoins =				[];
	
	//Items related to pages
	self.PageJoins =				[];
	self.PageJoinByName =			[];
	self.CurrentPage =				null;
	
	//String Join values
	self.SJValues =					[];

	//Connection event handler
	self.onConnectionChange = function (system, connected, remote) {
		if (connected != false) {
			self.sendMsg("\x01\x00\x07\x7F\x00\x00\x01\x00" + String.fromCharCode("0x" + self.IPID) + "\x40");	 //Send IP ID connect request
		} else {
			self.ConnectState(0);
		}
	};

	//Converts a string to hex for log output
	self.toHex = function (string) {
		var hex = '';
		for (var i = 0; i < string.length; i++) {
			hex += "\\x" + string.charCodeAt(i).toString(16);
		}
		return hex;
	};

	//Custom log implementation:
	self.log = function (msg) {
		if (CF.debug) {
			CF.log("Log: " + msg);
		}
	};

	self.sendMsg = function(msg) {
		CF.send(self.systemName, msg, CF.BINARY)
	};
	
		//TCP receive event handler. Will process all packets even if multiple messages received for single data event
	self.receive = function (itemName, data) {
		self.ourData += data;
		while (self.ourData.length >= 3) {
			var type = self.ourData.charCodeAt(0);
			var len = (self.ourData.charCodeAt(1) << 8) + self.ourData.charCodeAt(2);
			if (self.ourData.length < (3 + len)) {		// sanity check: buffer doesn't contain all the data advertised in the packet
				break;	
			}
			var payload = self.ourData.substr(3,len);
			self.ourData = self.ourData.substr(3 + len);
			self.processMessage(type, len, payload);	// process payload
		}
	};
	
	//parse a single incoming message from remote system
	self.processMessage = function (type, len, payload) {	
		if (type == 0x05) {	// data
			var dataType = payload.charCodeAt(3);
			if (dataType == 0x00) {	// digital feedback
				var joinData = (payload.charCodeAt(4) << 8) + payload.charCodeAt(5);
				var join = ((joinData >> 8) | ((joinData & 0x7F) << 8)) + 1;
				if (self.DJoin_Low <= join && join <= self.DJoin_High && join != self.DJoin_connectedFB) {
					CF.setJoin("d" + join, !(joinData & 0x0080), false);
				} else {
					self.log("Ignoring out of range Digital: " + join);
				}
			} else if (dataType == 0x01) {	// analog feedback
				var join = 0, value = 0, type = payload.charCodeAt(2);
				if (type == 4) { // Join < 256
					join = payload.charCodeAt(4) + 1;
					value = (payload.charCodeAt(5) << 8) + payload.charCodeAt(6);
				} else if (type == 5) {	// Join > 255
					join = (payload.charCodeAt(4) << 8) + payload.charCodeAt(5) + 1;
					value = (payload.charCodeAt(6) << 8) + payload.charCodeAt(7);
				}
				if (self.AJoin_Low <= join && join <= self.AJoin_High) {
					CF.setJoin("a" + join, value, false);
				} else {
					self.log("Ignoring out of range Analog: " + join);
				}
			} else if (dataType == 0x02) {	// serial feedback
				var pkg = payload.substr(4);
				var msg = pkg.split("\r");
				var joinLength = msg[0].indexOf(",") - 1;
				var join = parseInt(msg[0].substring(1,joinLength + 1));
				var sJoin = "s" + join;
				var text = "";
				if (self.SJoin_Low > join || join > self.SJoin_High) {
					self.log("Ignoring out of range Serial: " + join);
					return;
				}
				if (self.SJValues[sJoin] == undefined) {self.SJValues[sJoin] = "";}
				for (var i = 0; i < msg.length - 1; i++) {
					text = msg[i].substr(joinLength + 2);
					if (i == 0) {
						if(msg[i].charAt(0) === "#") {
							if (text.length == 0) {
								self.SJValues[sJoin] = text;
							} else if (text.length > 0) {
								self.SJValues[sJoin] = self.SJValues[sJoin] + "\r" + text;
							}
						} else if (msg[i].charAt(0) === "@") {
							self.SJValues[sJoin] = self.SJValues[sJoin] + text;
						}
					} else if (i > 0) {
						if (text.length == 0 && !(i == (msg.length-1) && self.SJValues[sJoin].length == 0)) {
							self.SJValues[sJoin] = self.SJValues[sJoin] + "\r";
						} else if (text.length > 0) {
							self.SJValues[sJoin] = self.SJValues[sJoin] + text;
						}
					}
				}
				CF.setJoin(sJoin,self.SJValues[sJoin], false);
			} else if (dataType == 0x03) {
				//update request confirmation, we receive this just before processor sends the UR data
			} else if (dataType == 0x08) {
				//Date & Time - Only sent during update request, so driving a join would require a clock.  Just for reference, for now.
			} else {
				//not accounted for...
				self.log(payload);
			}
		} else if (type == 0x02) {	//IP ID info
			if (payload == '\xff\xff\x02') {
				// IP ID Does not Exist, or booting, retry...
				self.ConnectState(0)
				self.log("IP ID Not Defined on Processor: " + self.IPID + ". Retrying...");	 //When program isn't fully booted on processor, it will reject
				self.sendMsg("\x01\x00\x07\x7F\x00\x00\x01\x00" + String.fromCharCode("0x" + self.IPID) + "\x40");
			} else if (len == 4) {
				// IP ID registry Success
				self.log("IP ID Registry Success")
				self.sendMsg("\x05\x00\x05\x00\x00\x02\x03\00"); //Send update request
				clearInterval(self.heartBeatTimer);
				self.heartBeatTimer = setInterval(function(){self.sendHeartBeat();}, self.heartBeatRate);
				self.ConnectState(1);
			} else {
				//not accounted for
				self.log(self.ourData);
			}
		} else if (type == 0x03) {
			//Program stopping/disconnecting.  Noting for future use.
		} else if (type == 0x0D || type == 0x0E) {
			// 0x0D heartbeat timeout - Processor sends an initiator heartbeat if it doesn't receive one and times out
			// 0x0E heartbeat response - Response to our initiator heartbeat.
			clearInterval(self.heartBeatTimer);
			self.heartBeatTimer = setInterval(function(){self.sendHeartBeat();}, self.heartBeatRate);
		} else if (type == 0x0F) {
			// processor response
			if (len == 1) {
				if (payload == '\x02') {	//IP ID Register request, send IPID
					self.ConnectState(0);
					self.log("IP ID Register Request, Sending: " + self.IPID);
					self.sendMsg("\x01\x00\x07\x7F\x00\x00\x01\x00" + String.fromCharCode("0x" + self.IPID) + "\x40");
				}
			} else {
				self.log(payload);
			}
		} else {
			self.log(payload);
		}
	};
	
	//Central method to handle all connection state feedback
	self.ConnectState = function (state) {
		switch (state) {
			case 0:
				CF.setJoin("d" + self.DJoin_connectedFB, false);
				self.log("Disconnected from IP ID: " + self.IPID);
				self.log("Clearing Joins...");
				CF.setJoins(self.ClearJoins, false);
				self.log("Done Clearing Joins");
				break;
			case 1:
				CF.setJoin("d" + self.DJoin_connectedFB, true);
				self.log("Connected to IP ID: " + self.IPID);
				//Watch pageflips
				CF.watch(CF.PageFlipEvent, self.pageFlipEvent, true);
				break;
		}
	};

	self.sendHeartBeat = function(){
		self.sendMsg("\x0d\x00\x02\x00\x00")
	}

	//Process gui elements to setup watch, clearing, and other functions
	self.processGui = function (gui) {
		//Setup join arrays of pages & joins
		for (var i=0, numPages=gui.pages.length; i < numPages; i++) {
			var joinVal = parseInt(gui.pages[i].join.substr(1))
			if (self.DJoin_Low <= joinVal && joinVal <= self.DJoin_High) {
				self.PageJoins[gui.pages[i].join] = true;
				self.PageJoinByName[gui.pages[i].name] = joinVal;
			}
		}
		
		//Setup join arrays for used joins monitoring and clearing
		for (var i=0, numJoins=gui.allJoins.length; i < numJoins; i++) {
		    var theJoin = gui.allJoins[i];
		    var type = theJoin.charAt(0);
		    var num = parseInt(theJoin.substr(1));
		    if (type === "d" && num >= self.DJoin_Low && num <= self.DJoin_High && num != self.DJoin_connectedFB && !self.PageJoins[theJoin]) {
		        //digital
		        self.DJoins.push(theJoin);
		        self.ClearJoins.push({join:theJoin, value:0});
		    } else if (type === "a" && num >= self.AJoin_Low && num <= self.AJoin_High) {
		        //analog
		        self.AJoins.push(theJoin);
		        self.ClearJoins.push({join:theJoin, value:0});
		
		    } else if (type === "s" && num >= self.SJoin_Low && num <= self.SJoin_High) {
		        //serial
		        self.SJoins.push(theJoin);
		        self.ClearJoins.push({join:theJoin, value:""});
		    }
		}
		
		//Watch joins
		CF.watch(CF.ObjectPressedEvent, self.DJoins, self.userDigitalPush);
		CF.watch(CF.ObjectReleasedEvent, self.DJoins, self.userDigitalRelease);
		CF.watch(CF.ObjectPressedEvent, self.AJoins, self.userAnalogEvent);
		CF.watch(CF.ObjectDraggedEvent, self.AJoins, self.userAnalogEvent);
		CF.watch(CF.ObjectReleasedEvent, self.AJoins, self.userAnalogEvent);
		CF.watch(CF.JoinChangeEvent, self.SJoins, self.userSerialEvent);
	};
	
	self.pageFlipEvent = function (from, to, orientation) {
		self.CurrentPage = to;

		//clear page joins
		for (var i in self.PageJoinByName) {
			var rawJoin = self.PageJoinByName[i] - 1;
			var upperByte = String.fromCharCode(rawJoin & 0xff);
			var lowerByte = String.fromCharCode((rawJoin >> 8) | 0x0080);
			self.sendMsg("\x05\x00\x06\x00\x00\x03\x00"+ upperByte + lowerByte);
		}

		//set join if page has join
		if (self.PageJoinByName[self.CurrentPage] != undefined) {
			var rawJoin = self.PageJoinByName[self.CurrentPage] - 1;
			var upperByte = String.fromCharCode(rawJoin & 0xff);
			var lowerByte = String.fromCharCode(rawJoin >> 8);
			self.sendMsg("\x05\x00\x06\x00\x00\x03\x00"+ upperByte + lowerByte);
		}
	};

	
	self.userDigitalPush = function (join, value, tokens) {
		var type = join.charCodeAt(0);
		var rawJoin = parseInt(join.substr(1)) - 1;
		var rawValue = parseInt(value);
		var upperByte, lowerByte;
		
		upperByte = String.fromCharCode(rawJoin & 0xff);
		lowerByte = String.fromCharCode(rawJoin >> 8);
		var msg = "\x05\x00\x06\x00\x00\x03\x27"+ upperByte + lowerByte;
		self.sendMsg(msg);
		self.HoldJoins[join] = setInterval(function(){self.sendMsg(msg);}, self.HoldRepeatTimer);	 //repeat the held join command
	};
	
	self.userDigitalRelease = function (join, value, tokens) {
		var type = join.charCodeAt(0);
		var rawJoin = parseInt(join.substr(1)) - 1;
		var upperByte, lowerByte;
		
		upperByte = String.fromCharCode(rawJoin & 0xff);
		clearInterval(self.HoldJoins[join]);
		lowerByte = String.fromCharCode((rawJoin >> 8) | 0x0080);
		self.sendMsg("\x05\x00\x06\x00\x00\x03\x27"+ upperByte + lowerByte);
		clearInterval(self.HoldJoins[join]);
	};
	
	self.userAnalogEvent = function (join, value, tokens) {
		var type = join.charCodeAt(0);
		var rawJoin = parseInt(join.substr(1)) - 1;
		var rawValue = parseInt(value);
		var joinUpper, joinLower, valUpper, valLower;
		
		joinUpper = String.fromCharCode(rawJoin >> 8);
		joinLower = String.fromCharCode(rawJoin & 0xff);
		valUpper = String.fromCharCode(rawValue >> 8);
		valLower = String.fromCharCode(rawValue & 0xff);
		self.sendMsg("\x05\x00\x08\x00\x00\x05\x14"+ joinUpper + joinLower + valUpper + valLower);
	};
	
	self.userSerialEvent = function (join, value, tokens) {
		var type = join.charCodeAt(0);
		var rawJoin = parseInt(join.substr(1)) - 1;
		var rawValue = parseInt(value);
		self.SJValues[join] = value;

		var payload = "\x00\x00" + String.fromCharCode(value.length + 2) + "\x12" + String.fromCharCode(rawJoin) + value;
		self.sendMsg("\x05\x00" + String.fromCharCode(payload.length) + payload);
	};
	
	//Initialization: General setup & Event monitors
	CF.watch(CF.ConnectionStatusChangeEvent, self.systemName, self.onConnectionChange, true);
	CF.watch(CF.FeedbackMatchedEvent, self.systemName, self.systemFeedbackName, self.receive);
	CF.getGuiDescription(self.processGui);
	//CF.watch(CF.GUIResumedEvent, self.onGUIResumed);

	self.log(	"\r\x09" + "CIP Ready for System: " + self.systemName + "\r" +
				"\x09" + "Module Version: " + self.version + "\r" +
				"\x09" + "IP ID: " + self.IPID + "\r" +
				"\x09" + "Online Feedback Join: " + self.DJoin_connectedFB + "\r" +
				"\x09" + "Digital Range: " + self.DJoin_Low + "-" + self.DJoin_High + "\r" +
				"\x09" + "Analog Range: " + self.AJoin_Low + "-" + self.AJoin_High + "\r" +
				"\x09" + "Serial Range: " + self.SJoin_Low + "-" + self.SJoin_High);
};