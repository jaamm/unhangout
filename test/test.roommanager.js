var RoomManager = require("../lib/room-manager").RoomManager,
    createUsers = require("../lib/passport-mock").createUsers,
    common = require("./common"), // common before options, so we can monkey-patch it
    models = require("../lib/server-models"),
    monotonic = require("../lib/monotonic-counter"),
    http = require("http"),
    async = require("async"),
    expect = require("expect.js"),
    sockjs = require("sockjs"),
    sockjs_client = require('sockjs-client-ws'),
    async = require("async"),
    Promise = require("bluebird"),
    sinon = require("sinon"),
    _ = require("underscore");

var users = createUsers(new models.ServerUserList());
var server = http.createServer();
var socketServer = sockjs.createServer({log: function(severity, message){
    if (severity == "error") {
        console.log("error", message);
    }
}});

// Connect an unauthenticated socket.
function connectSocket(connectCallback, dataCallback) {
    var sock = common.sockWithPromiseClose();
    sock.on("connection", function() { connectCallback(sock); });
    sock.on("data", function(message) {
        dataCallback(sock, JSON.parse(message));
    });
    sock.on("error", function(data) { throw new Error(data); });
}

// Get a socket authenticated for the given user.
function authedSocket(user, callback) {
    var sock = common.sockWithPromiseClose();
    sock.once("connection", function() {
        sock.write(JSON.stringify({
            type: "auth", args: {id: user.id, key: user.getSockKey()}
        }));
    });
    sock.once("data", function(message) {
        if (JSON.parse(message).type == "auth-ack") {
            callback(sock);
        } else {
            throw new Error(message);
        }
    });
    sock.on("error", function(data) {
        throw new Error(data);
    });
}

describe("ROOM MANAGER", function() {
    before(function() {
        socketServer.installHandlers(server, {prefix: '/sock'});
        server.listen(common.PORT, '0.0.0.0');
    });
    after(function() {
        server.close();
    });
    it("Fires auth events", function(done) {
        var mgr = new RoomManager(socketServer, users);
        var user = users.at(0);
        mgr.on("auth", function(data) {
            expect(data.first).to.be(true);
            expect(data.socket.user).to.eql(user);
        });
        connectSocket(
            function onConnect(sock) {
                sock.write(JSON.stringify({
                    type: "auth",
                    args: {id: user.id, key: user.getSockKey()}
                }));
            },
            function onData(sock, data) {
                mgr.destroy();
                if (data.type == "auth-ack") {
                    done();
                } else {
                    done(new Error(data));
                }
            }
        );
    });

    function refuseAuth(user, authMsg, done) {
        var mgr = new RoomManager(socketServer, users);
        mgr.on("auth", function(data) { done(new Error("Shouldn't've authed.")); });
        connectSocket(
            function onConnect(sock) {
                sock.write(JSON.stringify(authMsg));
            },
            function onData(sock, data) {
                mgr.destroy();
                sock.promiseClose().then(function() {
                    if (data.type == "auth-err") {
                        done();
                    } else {
                        done(new Error(data));
                    }
                });
           }
        );
    }
    it("Refuses auth without ID", function(done) {
        var user = users.at(0);
        refuseAuth(user, {type: "auth", args: {key: user.getSockKey()}}, done);
    });
    it("Refuses auth with non-matching ID", function(done) {
        var user = users.at(0),
            user2 = users.at(1);
        refuseAuth(user, {type: "auth", args: {id: user2.id, key: user.getSockKey()}}, done);
    });
    it("Refuses auth without Key", function(done) {
        var user = users.at(0);
        refuseAuth(user, {type: "auth", args: {id: user.id}}, done);
    });
    it("Refuses auth with non-matching key", function(done) {
        var user = users.at(0),
            user2 = users.at(1);
        refuseAuth(user, {type: "auth", args: {id: user.id, key: user2.getSockKey()}}, done);
    });
    it("Refuses auth with bogus key", function(done) {
        var user = users.at(0);
        refuseAuth(user, {type: "auth", args: {id: user.id, key: "bogus"}}, done);
    });

    it("Joining and leaving rooms", function(done) {
        var user = users.at(0);
        var user2 = users.at(1);
        var mgr = new RoomManager(socketServer, users);
        // Client socks.
        var clientSock1, clientSock2, clientSock3;
        // Server socks.
        var socket1, socket2, socket3;
        // Params from join/leave triggers.
        var args1, args2, args3;

        // Expectations with one socket from `user` in the room.
        function expectOne(socket, args) {
            expect(mgr.roomToSockets).to.eql({"someroom": [socket]});

            var socketIdToRooms = {};
            socketIdToRooms[socket.id] = ["someroom"];
            expect(mgr.socketIdToRooms).to.eql(socketIdToRooms);

            expect(mgr.roomToUsers).to.eql({"someroom": [user]});
            expect(mgr.socketBindings[socket.id]).to.not.be(undefined);
        }

        // Expectations with two sockets from `user` in the room.
        function expectTwo(socket, args) {
            expect(mgr.roomToSockets.someroom.length).to.be(2);
            expect(_.contains(mgr.roomToSockets.someroom, socket)).to.be(true);

            expect(_.size(mgr.socketIdToRooms)).to.be(2);
            expect(mgr.socketIdToRooms[socket.id]).to.eql(["someroom"]);

            expect(mgr.userIdToSockets[user.id].length).to.be(2);
            expect(_.contains(mgr.userIdToSockets[user.id], socket)).to.be(true);

            expect(mgr.socketIdToUser[socket.id]).to.eql(user);

            expect(mgr.roomToUsers).to.eql({"someroom": [user]});
            expect(mgr.socketBindings[socket.id]).to.not.be(undefined);
        }

        // Expectations with two sockets from `user` and one from `user2` in the room.
        function expectThree(socket, args) {
            expect(mgr.roomToSockets.someroom.length).to.be(3);
            expect(_.contains(mgr.roomToSockets.someroom, socket)).to.be(true);
            expect(_.size(mgr.socketIdToRooms)).to.be(3);
            expect(mgr.socketIdToRooms[socket.id]).to.eql(["someroom"]);
            expect(_.size(mgr.userIdToSockets)).to.be(2);
            expect(mgr.userIdToSockets[user2.id]).to.eql([socket]);
            expect(mgr.socketIdToUser[socket.id]).to.eql(user2);
            expect(mgr.roomToUsers.someroom.length).to.be(2);
            expect(_.contains(mgr.roomToUsers.someroom, user)).to.be(true);
            expect(mgr.socketBindings[socket.id]).to.not.be(undefined);
        }
        /*
         * Here we do a big narrative sequence of events to put the room
         * manager through its paces.
         */
        async.series([
            // The first socket joins a room.
            function(done) {
                authedSocket(user, function(sock) {
                    clientSock1 = sock;
                    sock.write(JSON.stringify({type: "join", args: {id: "someroom"}}));
                    async.parallel([
                        function(done) {
                            sock.on("data", function(message) {
                                expect(JSON.parse(message).type).to.be("join-ack");
                                done();
                            });
                        },
                        function(done) {
                            mgr.once("join", function(socket, args) {
                                socket1 = socket;
                                args1 = args;
                                expect(socket.user.id).to.eql(user.id); // we are authed
                                expect(args.roomFirst).to.be(true); // we're the first in this room
                                expect(args.userFirst).to.be(true); // This is our first socket in the room.
                                expectOne(socket, args);

                                // At this point, mgr.userIdToSockets only contains ourselves.
                                var userIdToSockets = {};
                                userIdToSockets[user.id] = [socket];
                                expect(mgr.userIdToSockets).to.eql(userIdToSockets);

                                // ... as does mgr.socketIdToUser.
                                var socketIdToUser = {};
                                socketIdToUser[socket.id] = user;
                                expect(mgr.socketIdToUser).to.eql(socketIdToUser);
                                done();
                            });
                        }
                    ], function() { done(); });
                });
            },
            function(done) {
                // Join a second socket from the same user.
                authedSocket(user, function(sock) {
                    clientSock2 = sock;
                    sock.write(JSON.stringify({type: "join", args: {id: "someroom"}}));
                    async.parallel([
                        function(done) {
                            sock.once("data", function(message) {
                                expect(JSON.parse(message).type).to.be("join-ack");
                                done();
                            });
                        },
                        function(done) {
                            mgr.once("join", function(socket, args) {
                                socket2 = socket;
                                args2 = args;
                                expect(socket2.user.id).to.eql(user.id);
                                // This is our 2nd sock in this room.
                                expect(args2.userFirst).to.be(false);
                                // and the 2nd sock in the room, period.
                                expect(args2.roomFirst).to.be(false);
                                expectTwo(socket2, args2);
                                done();
                            });
                        }
                    ], function() { done(); });
                });
            },
            function(done) {
                // Join a third socket from a different user.
                authedSocket(user2, function(sock) {
                    clientSock3 = sock;
                    sock.write(JSON.stringify({type: "join", args: {id: "someroom"}}));
                    async.parallel([
                        function(done) {
                            sock.once("data", function(message) {
                                expect(JSON.parse(message).type).to.be("join-ack");
                                done();
                            });
                        },
                        function(done) {
                            mgr.once("join", function(socket, args) {
                                socket3 = socket;
                                args3 = args;
                                expect(socket3.user.id).to.eql(user2.id);
                                expect(args3.roomId).to.be("someroom");
                                expect(args3.userFirst).to.be(true); // user2's first sock
                                expect(args3.roomFirst).to.be(false); // but the room's third
                                expectThree(socket3, args3);

                                expect(mgr.getUsers("someroom")).to.eql([user, user2]);
                                done();
                            });
                        }
                    ], function() {
                        done();
                    });
                });
            },
            function(done) {
                // Third socket leaves by "leave" message.
                clientSock3.write(JSON.stringify({type: "leave", args: {id: "someroom"}}));
                async.parallel([
                    function(done) {
                        clientSock3.once("data", function(message) {
                            expect(JSON.parse(message).type).to.eql("leave-ack");
                            expectTwo(socket2, args2);
                            done();
                        });
                    },
                    function(done) {
                        mgr.once("leave", function(socket, args) {
                            expect(args.roomId).to.be("someroom");
                            expect(socket).to.eql(socket3);
                            expect(args.userLast).to.be(true);
                            expect(args.roomLast).to.be(false);
                            done();
                        });
                    }
                ], function() { done(); });
            },

            function(done) {
                // Second socket leaves by disconnect.
                Promise.all([
                    clientSock2.promiseClose(),
                    new Promise(function(resolve, reject) {
                        mgr.once("leave", function(socket, args) {
                            expectOne(socket1, args1);
                            expect(args.roomId).to.be("someroom");
                            expect(socket).to.eql(socket2);
                            // Still have another socket in this room from this user..
                            expect(args.roomLast).to.be(false);
                            expect(args.userLast).to.be(false);
                            resolve();
                        });
                    })
                ]).then(function() { done(); });
            },
            function(done) {
                // First socket leaves by disconnect, leaving the room empty.
                Promise.all([
                    clientSock1.promiseClose(),
                    new Promise(function(resolve, reject) {
                        mgr.once("leave", function(socket, args) {
                            expect(args.roomId).to.eql("someroom");
                            expect(socket).to.eql(socket);
                            expect(args.roomLast).to.be(true);
                            expect(args.userLast).to.be(true);

                            expect(_.size(mgr.roomToSockets)).to.be(0);
                            expect(_.size(mgr.socketIdToRooms)).to.be(0);
                            // Only one socket didn't disconnect -- it's still authed.
                            expect(_.size(mgr.socketIdToUser)).to.be(1);
                            expect(_.size(mgr.userIdToSockets)).to.be(1);
                            expect(_.values(mgr.userIdToSockets).length).to.be(1);
                            expect(_.size(mgr.roomToUsers)).to.be(0);

                            mgr.destroy();
                            socket.close();
                            clientSock3.promiseClose().then(function() {
                                resolve();
                            });
                        });
                    })
                ]).then(function() { done(); });
            }
        ], function() {
            done();
        });
    });


    it("Fires disconnect for unauthenticated users", function(done) {
        var mgr = new RoomManager(socketServer, users);
        var user = users.at(0);
        var sock;
        connectSocket(
            function onConnect(theSock) {
                sock = theSock;
                Promise.all([
                    sock.promiseClose(),
                    new Promise(function(resolve, reject) {
                        mgr.on("disconnect", function(socket, args) {
                            expect(args.authenticated).to.be(false);
                            expect(args.last).to.be(null);
                            mgr.destroy();
                            resolve();
                        });
                    })
                ]).then(function() { done(); });
            },
            function onData(sock, data) {
                // Don't expect any data...
                throw new Error(data);
            }
        )
    });

    it("Fires disconnect for authenticated users", function(done) {
        var mgr = new RoomManager(socketServer, users);
        var user = users.at(0);
        authedSocket(user, function(clientSock1) {
            authedSocket(user, function(clientSock2) {
                Promise.all([
                    clientSock1.promiseClose(),
                    new Promise(function(resolve, reject) {
                        mgr.once("disconnect", function(socket, args) {
                            expect(args.authenticated).to.be(true);
                            expect(args.last).to.be(false);
                            resolve();
                        })
                    }).then(function() {
                        return Promise.all([
                            clientSock2.promiseClose(),
                            new Promise(function(resolve, reject) {
                                mgr.once("disconnect", function(socket, args) {
                                    expect(args.authenticated).to.be(true);
                                    expect(args.last).to.be(true);
                                    mgr.destroy();
                                    resolve();
                                });
                            })
                        ]);
                    })
                ]).then(function() { done(); });
            });
        });
    });

    function roomSocket(user, room, callback) {
        authedSocket(user, function(sock) {
            sock.write(JSON.stringify({type: "join", args: {id: room}}));
            sock.once("data", function(message) {
                expect(JSON.parse(message).type).to.eql("join-ack");
                callback(sock);
            });
        });
    }

    it("Broadcasts to rooms", function(done) {
        var mgr = new RoomManager(socketServer, users);
        var user1 = users.at(0);
        var user2 = users.at(1);
        var data = {type: "doge", args: {so: "wow"}};
        roomSocket(user1, "funroom", function(clientSock1) {
            roomSocket(user1, "funroom", function(clientSock2) {
                roomSocket(user2, "funroom", function(clientSock3) {
                    expect(mgr.roomToSockets.funroom.length).to.be(3);
                    clientSock1.on("data", function(message) {
                        throw new Error("Shouldn't have gotten data");
                    });
                    async.parallel([
                        function(done) {
                            clientSock2.once("data", function(message) {
                                var msg = JSON.parse(message);
                                expect(msg.timestamp).to.be.an('array');
                                expect(msg.timestamp.length).to.be(2);
                                delete msg.timestamp;
                                expect(msg).to.eql(data);
                                done();
                            });
                        },
                        function(done) {
                            clientSock3.once("data", function(message) {
                                var msg = JSON.parse(message);
                                expect(msg.timestamp).to.be.an('array');
                                expect(msg.timestamp.length).to.be(2);
                                delete msg.timestamp;
                                expect(msg).to.eql(data);
                                done();
                            });
                        }
                    ], function() {
                        mgr.destroy();
                        Promise.all([
                            clientSock1.promiseClose(),
                            clientSock2.promiseClose(),
                            clientSock3.promiseClose(),
                        ]).then(function() {
                            done();
                        });
                    });
                    // broadcast to everyone but clientSock1.
                    mgr.broadcast('funroom', data.type, data.args, function(s) {
                        return s.id != mgr.userIdToSockets[user1.id][0].id
                    });
                });
            });
        });

    });

    it("Restricts joining with channel auth", function(done) {
        var mgr = new RoomManager(socketServer, users);
        var regular = users.findWhere({superuser: false});
        var superuser = users.findWhere({superuser: true});
        // Create an authorization function on the "superuser" channel, which
        // checks that a user is authenticated and is a superuser.
        mgr.channelAuth.superuser = function(socket, room, callback) {
            var authorized = socket.user && socket.user.isSuperuser();
            callback(null, authorized);
        };
        // Try to join a room in "superuser":
        async.parallel([
            // Join as a non-superuser that won't be authorized.
            function(done) {
                authedSocket(regular, function(sock) {
                    sock.write(JSON.stringify({type: "join", args: {id: "superuser/1"}}));
                    sock.once("data", function(message) {
                        var data = JSON.parse(message);
                        expect(data.type).to.be("join-err");
                        expect(data.args).to.be("Permission to join superuser/1 denied.");
                        sock.promiseClose().then(function() {
                            done();
                        });
                    });
                });
            },
            // Join as a superuser that will be authorized.
            function(done) {
                authedSocket(superuser, function(sock) {
                    sock.write(JSON.stringify({type: "join", args: {id: "superuser/1"}}));
                    sock.once("data", function(message) {
                        var data = JSON.parse(message);
                        expect(data.type).to.be("join-ack");
                        sock.promiseClose().then(function() {
                            done();
                        });
                    });
                });
            }
        ], function() {
            mgr.destroy();
            done();
        });
    });
    it("determines if a room contains a socket", function(done) {
        var user1 = users.at(0),
            user2 = users.at(1);
        var mgr = new RoomManager(socketServer, users);
        roomSocket(user1, "funroom", function(clientSock1) {
            roomSocket(user2, "funroom", function(clientSock2) {
                authedSocket(user2, function(clientSock3) {
                    expect(
                        mgr.roomContainsSocket("funroom", mgr.userIdToSockets[user1.id][0])
                    ).to.be(true);
                    expect(
                        mgr.roomContainsSocket("funroom", mgr.userIdToSockets[user2.id][0])
                    ).to.be(true);
                    expect(
                        mgr.roomContainsSocket("funroom", mgr.userIdToSockets[user2.id][1])
                    ).to.be(false);
                    mgr.destroy();
                    Promise.all([
                        clientSock1.promiseClose(),
                        clientSock2.promiseClose(),
                        clientSock3.promiseClose(),
                    ]).then(function() {
                        done();
                    });
                });
            });
        });
    });
    it("Refuses join with invalid timestamps", function(done) {
        var user = users.at(0);
        var mgr = new RoomManager(socketServer, users);
        authedSocket(user, function(sock) {
            sock.write(JSON.stringify({
                type: "join", args: {id: "someroom", timestamp: "bogus"}
            }));
            sock.once("data", function(message) {
                var msg = JSON.parse(message);
                expect(msg.type).to.be("join-err");
                expect(msg.args).to.be("Invalid timestamp");
                // Ensure we didn't join.
                expect(mgr.roomToSockets.someroom).to.be(undefined);
                expect(mgr.socketIdToRooms[sock.id]).to.be(undefined);
                expect(mgr.roomToUsers.someroom).to.be(undefined);
                sock.promiseClose().then(function() {
                    mgr.destroy(); 
                    done();
                });
            });
        });

    });
    it("sends 'stale-state-err' if joining with timestamp too old", function(done) {
        var user = users.at(0);
        var mgr = new RoomManager(socketServer, users);
        var hrnow = monotonic.timestamp();
        hrnow[0] = hrnow[0] - mgr.OP_LOG_AGE;
        authedSocket(user, function(sock) {
            sock.write(JSON.stringify({
                type: "join",
                args: {id: "someroom", timestamp: hrnow}
            }));
            sock.once("data", function(message) {
                var msg = JSON.parse(message);
                expect(msg.type).to.be("stale-state-err");
                // Ensure we didn't join.
                expect(mgr.roomToSockets.someroom).to.be(undefined);
                expect(mgr.socketIdToRooms[sock.id]).to.be(undefined);
                expect(mgr.roomToUsers.someroom).to.be(undefined);
                sock.promiseClose().then(function() {
                    mgr.destroy();
                    done();
                });
            });
        });
    });

    it("catches sockets up if they present a timestamp on join", function(done) {
        var user = users.at(0);
        // A timestamp, before any messages have been sent, which we'll present
        // for the user.
        var mgr = new RoomManager(socketServer, users);
        var hrnow = monotonic.timestamp();
        // queue up a few messages..
        mgr.sync("someroom", "important", [1, 2, 3]);
        mgr.sync("someroom", "don't forget", [4, 5, 6]);


        // Now connect a socket, which should get the messages in order.
        authedSocket(user, function(sock) {
            var messages = [];
            var expected = [
                ["join-ack", undefined],
                ["important", [1, 2, 3]],
                ["don't forget", [4, 5, 6]]
            ];

            // The routine that will be called on data..
            var finish = _.after(expected.length, function() {
                expect(messages).to.eql(expected);
                sock.promiseClose().then(function() {
                    mgr.destroy();
                    done();
                });
            });

            sock.write(JSON.stringify({
                type: "join",
                args: {id: "someroom", timestamp: hrnow}
            }));
            sock.on("data", function(message) {
                var msg = JSON.parse(message);
                messages.push([msg.type, msg.args]);
                finish();
            });
        });
    });

    it("Doesn't resend messages before the timestamp", function(done) {
        var user = users.at(0);
        // A timestamp, before any messages have been sent, which we'll present
        // for the user.
        var mgr = new RoomManager(socketServer, users);
        var hrnow = monotonic.timestamp();
        // queue up a few messages..
        mgr.sync("someroom", "important", [1, 2, 3]);
        mgr.sync("someroom", "don't forget", [4, 5, 6]);
        // Munge the log so that the first message comes *before* the timestamp
        expect(mgr.opLog.someroom[0][1]).to.be("important");
        mgr.opLog.someroom[0][0][0] = hrnow[0] - 1; // back one second

        // Now connect a socket, which should get the messages in order.
        authedSocket(user, function(sock) {
            var messages = [];
            var expected = [
                ["join-ack", undefined],
                ["don't forget", [4, 5, 6]]
            ];

            // The routine that will be called on data..
            var finish = _.after(expected.length, function() {
                expect(messages).to.eql(expected);
                sock.promiseClose().then(function() {
                    mgr.destroy();
                    done();
                });
            });

            sock.write(JSON.stringify({
                type: "join",
                args: {id: "someroom", timestamp: hrnow}
            }));
            sock.on("data", function(message) {
                var msg = JSON.parse(message);
                messages.push([msg.type, msg.args]);
                finish();
            });
        });
    });
    it("Clears sync log messages with timestamps that are too old", function() {
        var mgr = new RoomManager(socketServer, users);
        mgr.sync("someroom", "important", [1, 2, 3]);
        mgr.opLog.someroom[0][0][0] -= mgr.OP_LOG_AGE - 1;
        mgr.sync("someroom", "yeah dog", [4, 5, 6]);
        expect(mgr.opLog.someroom.length).to.be(1);
        expect(mgr.opLog.someroom[0][1]).to.eql("yeah dog");
        mgr.destroy();
    });

    it("Counts monotonically", function() {
        var clock = sinon.useFakeTimers(0, "setTimeout", "clearTimeout", "Date");
        monotonic._resetCount();

        // Starts at time 0 with counter 1.
        expect(monotonic.timestamp()).to.eql([0, 1]);
        // 1 millisecond should advance time, but not clear counter.
        clock.tick(1)
        // multiple messages in the same millisecond inc the counter.
        expect(monotonic.timestamp()).to.eql([1, 2]);
        expect(monotonic.timestamp()).to.eql([1, 3]);
        expect(monotonic.timestamp()).to.eql([1, 4]);
        // Subsequent ticks of less than 2ms continue incing counter.
        clock.tick(1)
        expect(monotonic.timestamp()).to.eql([2, 5]);
        clock.tick(1)
        expect(monotonic.timestamp()).to.eql([3, 6]);
        // but a gap of 2ms clears the counter.
        clock.tick(2)
        expect(monotonic.timestamp()).to.eql([5, 1]);
        clock.tick(2)
        expect(monotonic.timestamp()).to.eql([7, 1]);
        clock.restore();
    });
});
