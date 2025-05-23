/*jslint bitwise: true, node: true */
'use strict';

const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const SAT = require('sat');

const gameLogic = require('./game-logic');
const loggingRepositry = require('./repositories/logging-repository');
const chatRepository = require('./repositories/chat-repository');
const config = require('../../config');
const util = require('./lib/util');
const mapUtils = require('./map/map');
const { getPosition } = require("./lib/entityUtils");

let map = new mapUtils.Map(config);

let sockets = {};
let spectators = [];
const INIT_MASS_LOG = util.mathLog(config.defaultPlayerMass, config.slowBase);

let leaderboard = [];
let leaderboardChanged = false;

const Vector = SAT.Vector;

let matchmakingQueue = [];
let activeRooms = {}; // { roomId: { players: [socketId], spectators: [socketId], ... } }
let roomIdCounter = 1;
let aiIdCounter = 1;
let aiTimeout = null;

app.use(express.static(__dirname + '/../client'));

io.on('connection', function (socket) {
    let type = socket.handshake.query.type;
    console.log('User has connected: ', type);
    switch (type) {
        case 'player':
            addPlayer(socket);
            break;
        case 'spectator':
            addSpectator(socket);
            break;
        default:
            console.log('Unknown user type, not doing anything.');
    }

    // 只注册全局事件（匹配、观战、队列/房间清理等）
    socket.on('join_matchmaking', () => {
        if (matchmakingQueue.includes(socket.id)) return;
        matchmakingQueue.push(socket.id);
        socket.emit('matching', { waiting: 3 - matchmakingQueue.length });
        if (matchmakingQueue.length >= 3) {
            // 创建房间
            const roomId = 'room_' + (roomIdCounter++);
            const players = matchmakingQueue.splice(0, 3);
            activeRooms[roomId] = { players: [...players], spectators: [], status: 'playing', createdAt: Date.now() };
            // 通知三名玩家进入房间
            players.forEach(pid => {
                const psocket = io.sockets.sockets.get(pid);
                if (psocket) {
                    psocket.join(roomId);
                    psocket.emit('match_found', { roomId });
                }
            });
            if (aiTimeout) clearTimeout(aiTimeout);
        } else {
            // 通知所有等待玩家当前等待人数
            matchmakingQueue.forEach(pid => {
                const psocket = io.sockets.sockets.get(pid);
                if (psocket) {
                    psocket.emit('matching', { waiting: 3 - matchmakingQueue.length });
                }
            });
            if (aiTimeout) clearTimeout(aiTimeout);
            aiTimeout = setTimeout(() => {
                tryMatchWithAI();
            }, 10000);
        }
    });

    socket.on('get_rooms', () => {
        // 只返回正在进行中的房间
        const rooms = Object.entries(activeRooms)
            .filter(([_, room]) => room.status === 'playing')
            .map(([roomId, room]) => ({
                roomId,
                playerCount: room.players.length,
                spectatorCount: room.spectators.length,
                createdAt: room.createdAt
            }));
        socket.emit('room_list', rooms);
    });

    socket.on('spectate_room', ({ roomId }) => {
        const room = activeRooms[roomId];
        if (room && room.status === 'playing') {
            room.spectators.push(socket.id);
            socket.join(roomId);
            socket.emit('spectate_joined', { roomId });
        } else {
            socket.emit('spectate_failed', { reason: '房间不存在或已结束' });
        }
    });

    // 只做队列和房间观众清理，不操作 currentPlayer
    socket.on('disconnect', () => {
        const idx = matchmakingQueue.indexOf(socket.id);
        if (idx !== -1) matchmakingQueue.splice(idx, 1);
        Object.values(activeRooms).forEach(room => {
            const sidx = room.spectators.indexOf(socket.id);
            if (sidx !== -1) room.spectators.splice(sidx, 1);
            const pidx = room.players.indexOf(socket.id);
            if (pidx !== -1) room.players.splice(pidx, 1);
        });

        // === 自动清理房间和AI ===
        for (const [roomId, room] of Object.entries(activeRooms)) {
            // 只保留真人玩家
            const realPlayers = room.players.filter(pid => !pid.startsWith('AI_'));
            const remainingAIs = room.players.filter(pid => pid.startsWith('AI_'));

            // 只有当没有真实玩家，且（没有观众或AI数量不足）时才清理房间
            if (realPlayers.length === 0 &&
                (room.spectators.length === 0 || remainingAIs.length <= 1)) {
                // 删除房间内所有AI玩家
                room.players.forEach(pid => {
                    if (pid.startsWith('AI_')) {
                        // 从 map.players.data 里移除AI
                        const aiIndex = map.players.findIndexByID(pid);
                        if (aiIndex > -1) {
                            map.players.removePlayerByIndex(aiIndex);
                        }
                    }
                });
                // 删除房间
                delete activeRooms[roomId];
            } else if (realPlayers.length === 0 && room.spectators.length > 0 && remainingAIs.length > 1) {
                // 如果还有观众且有多个AI，通知观众AI继续对战
                room.spectators.forEach(pid => {
                    const psocket = io.sockets.sockets.get(pid);
                    if (psocket) {
                        psocket.emit('ai_continue', {
                            roomId,
                            aiCount: remainingAIs.length
                        });
                    }
                });
                // 更新房间状态，只保留AI
                room.players = remainingAIs;
            }
        }
    });
});

function generateSpawnpoint() {
    let radius = util.massToRadius(config.defaultPlayerMass);
    return getPosition(config.newPlayerInitialPosition === 'farthest', radius, map.players.data)
}

const addPlayer = (socket) => {
    var currentPlayer = new mapUtils.playerUtils.Player(socket.id);

    socket.on('gotit', function (clientPlayerData) {
        console.log('[INFO] Player ' + clientPlayerData.name + ' connecting!');
        currentPlayer.init(generateSpawnpoint(), config.defaultPlayerMass);

        if (map.players.findIndexByID(socket.id) > -1) {
            console.log('[INFO] Player ID is already connected, kicking.');
            socket.disconnect();
        } else if (!util.validNick(clientPlayerData.name)) {
            socket.emit('kick', 'Invalid username.');
            socket.disconnect();
        } else {
            console.log('[INFO] Player ' + clientPlayerData.name + ' connected!');
            sockets[socket.id] = socket;

            const sanitizedName = clientPlayerData.name.replace(/(<([^>]+)>)/ig, '');
            clientPlayerData.name = sanitizedName;

            currentPlayer.clientProvidedData(clientPlayerData);
            map.players.pushNew(currentPlayer);
            io.emit('playerJoin', { name: currentPlayer.name });
            console.log('Total players: ' + map.players.data.length);
        }
    });

    socket.on('pingcheck', () => {
        socket.emit('pongcheck');
    });

    socket.on('windowResized', (data) => {
        currentPlayer.screenWidth = data.screenWidth;
        currentPlayer.screenHeight = data.screenHeight;
    });

    socket.on('respawn', () => {
        map.players.removePlayerByID(currentPlayer.id);
        socket.emit('welcome', currentPlayer, {
            width: config.gameWidth,
            height: config.gameHeight
        });
        console.log('[INFO] User ' + currentPlayer.name + ' has respawned');
    });

    socket.on('playerChat', (data) => {
        var _sender = data.sender.replace(/(<([^>]+)>)/ig, '');
        var _message = data.message.replace(/(<([^>]+)>)/ig, '');

        if (config.logChat === 1) {
            console.log('[CHAT] [' + (new Date()).getHours() + ':' + (new Date()).getMinutes() + '] ' + _sender + ': ' + _message);
        }

        socket.broadcast.emit('serverSendPlayerChat', {
            sender: currentPlayer.name,
            message: _message.substring(0, 35)
        });

        chatRepository.logChatMessage(_sender, _message, currentPlayer.ipAddress)
            .catch((err) => console.error("Error when attempting to log chat message", err));
    });

    socket.on('pass', async (data) => {
        const password = data[0];
        if (password === config.adminPass) {
            console.log('[ADMIN] ' + currentPlayer.name + ' just logged in as an admin.');
            socket.emit('serverMSG', 'Welcome back ' + currentPlayer.name);
            socket.broadcast.emit('serverMSG', currentPlayer.name + ' just logged in as an admin.');
            currentPlayer.admin = true;
        } else {
            console.log('[ADMIN] ' + currentPlayer.name + ' attempted to log in with the incorrect password: ' + password);

            socket.emit('serverMSG', 'Password incorrect, attempt logged.');

            loggingRepositry.logFailedLoginAttempt(currentPlayer.name, currentPlayer.ipAddress)
                .catch((err) => console.error("Error when attempting to log failed login attempt", err));
        }
    });

    socket.on('kick', (data) => {
        if (!currentPlayer.admin) {
            socket.emit('serverMSG', 'You are not permitted to use this command.');
            return;
        }

        var reason = '';
        var worked = false;
        for (let playerIndex in map.players.data) {
            let player = map.players.data[playerIndex];
            if (player.name === data[0] && !player.admin && !worked) {
                if (data.length > 1) {
                    for (var f = 1; f < data.length; f++) {
                        if (f === data.length) {
                            reason = reason + data[f];
                        }
                        else {
                            reason = reason + data[f] + ' ';
                        }
                    }
                }
                if (reason !== '') {
                    console.log('[ADMIN] User ' + player.name + ' kicked successfully by ' + currentPlayer.name + ' for reason ' + reason);
                }
                else {
                    console.log('[ADMIN] User ' + player.name + ' kicked successfully by ' + currentPlayer.name);
                }
                socket.emit('serverMSG', 'User ' + player.name + ' was kicked by ' + currentPlayer.name);
                sockets[player.id].emit('kick', reason);
                sockets[player.id].disconnect();
                map.players.removePlayerByIndex(playerIndex);
                worked = true;
            }
        }
        if (!worked) {
            socket.emit('serverMSG', 'Could not locate user or user is an admin.');
        }
    });

    // Heartbeat function, update everytime.
    socket.on('0', (target) => {
        currentPlayer.lastHeartbeat = new Date().getTime();
        if (target.x !== currentPlayer.x || target.y !== currentPlayer.y) {
            currentPlayer.target = target;
        }
    });

    socket.on('1', function () {
        const minCellMass = config.defaultPlayerMass + config.fireFood;
        for (let i = 0; i < currentPlayer.cells.length; i++) {
            if (currentPlayer.cells[i].mass >= minCellMass) {
                currentPlayer.changeCellMass(i, -config.fireFood);
                map.massFood.addNew(currentPlayer, i, config.fireFood);
            }
        }
    });

    socket.on('2', () => {
        currentPlayer.userSplit(config.limitSplit, config.defaultPlayerMass);
    });

    socket.on('disconnect', () => {
        map.players.removePlayerByID(currentPlayer.id);
        console.log('[INFO] User ' + currentPlayer.name + ' has disconnected');
        socket.broadcast.emit('playerDisconnect', { name: currentPlayer.name });
    });
}

const addSpectator = (socket) => {
    socket.on('gotit', function () {
        sockets[socket.id] = socket;
        spectators.push(socket.id);
        io.emit('playerJoin', { name: '' });
        // 观众一进来就推送最新 leaderboard
        sendLeaderboard(socket);
    });

    socket.emit("welcome", {}, {
        width: config.gameWidth,
        height: config.gameHeight
    });
}

const tickPlayer = (currentPlayer) => {
    if (currentPlayer.lastHeartbeat < new Date().getTime() - config.maxHeartbeatInterval) {
        if (sockets[currentPlayer.id]) {
            sockets[currentPlayer.id].emit('kick', 'Last heartbeat received over ' + config.maxHeartbeatInterval + ' ago.');
            sockets[currentPlayer.id].disconnect();
        }
    }

    // AI没有目标时不移动
    if (currentPlayer.isAI && !currentPlayer.target) {
        return;
    }
    // cells为空时不移动
    if (!currentPlayer.cells || currentPlayer.cells.length === 0) {
        return;
    }
    // AI移动日志
    if (currentPlayer.isAI) {
        console.log(`[AI][${currentPlayer.id}] move前 坐标: (${currentPlayer.x},${currentPlayer.y}) target:`, currentPlayer.target);
    }
    currentPlayer.move(config.slowBase, config.gameWidth, config.gameHeight, INIT_MASS_LOG);
    if (currentPlayer.isAI) {
        console.log(`[AI][${currentPlayer.id}] move后 坐标: (${currentPlayer.x},${currentPlayer.y}) target:`, currentPlayer.target);
    }

    const isEntityInsideCircle = (point, circle) => {
        return SAT.pointInCircle(new Vector(point.x, point.y), circle);
    };

    const canEatMass = (cell, cellCircle, cellIndex, mass) => {
        if (isEntityInsideCircle(mass, cellCircle)) {
            if (mass.id === currentPlayer.id && mass.speed > 0 && cellIndex === mass.num)
                return false;
            if (cell.mass > mass.mass * 1.1)
                return true;
        }

        return false;
    };

    const canEatVirus = (cell, cellCircle, virus) => {
        return virus.mass < cell.mass && isEntityInsideCircle(cell, cellCircle, virus)
    }

    const cellsToSplit = [];
    let leaderboardShouldUpdate = false;
    for (let cellIndex = 0; cellIndex < currentPlayer.cells.length; cellIndex++) {
        const currentCell = currentPlayer.cells[cellIndex];

        const cellCircle = currentCell.toCircle();

        const eatenFoodIndexes = util.getIndexes(map.food.data, food => isEntityInsideCircle(food, cellCircle));
        const eatenMassIndexes = util.getIndexes(map.massFood.data, mass => canEatMass(currentCell, cellCircle, cellIndex, mass));
        const eatenVirusIndexes = util.getIndexes(map.viruses.data, virus => canEatVirus(currentCell, cellCircle, virus));

        if (eatenVirusIndexes.length > 0) {
            cellsToSplit.push(cellIndex);
            map.viruses.delete(eatenVirusIndexes)
        }

        // 修正顺序：先计算massGained，再删除
        let massGained = eatenMassIndexes.reduce((acc, index) => acc + map.massFood.data[index].mass, 0);
        massGained += (eatenFoodIndexes.length * Math.max(1, config.foodMass));

        if (massGained > 0) {
            leaderboardShouldUpdate = true;
            currentPlayer.changeCellMass(cellIndex, massGained);
        }

        map.food.delete(eatenFoodIndexes);
        map.massFood.remove(eatenMassIndexes);
    }
    currentPlayer.virusSplit(cellsToSplit, config.limitSplit, config.defaultPlayerMass);

    // 新增：只要有吃球/吃人就立即推送 leaderboard
    if (leaderboardShouldUpdate) {
        // 重新计算排行榜
        calculateLeaderboard();
        // 推送给所有玩家和观众
        for (const id in sockets) {
            sendLeaderboard(sockets[id]);
        }
        spectators.forEach(id => {
            if (sockets[id]) sendLeaderboard(sockets[id]);
        });
    }
    // 修复：同步主坐标为cells[0]坐标，保证AI决策和移动一致
    if (currentPlayer.cells && currentPlayer.cells.length > 0) {
        currentPlayer.x = currentPlayer.cells[0].x;
        currentPlayer.y = currentPlayer.cells[0].y;
    }

    // 日志：Player主坐标、cells.length、cells[0]坐标
    console.log(`[Player][${currentPlayer.id}] [tickPlayer] 主坐标: (${currentPlayer.x},${currentPlayer.y}), cells.length: ${currentPlayer.cells ? currentPlayer.cells.length : 0}, cells[0]:`, currentPlayer.cells && currentPlayer.cells[0] ? `(${currentPlayer.cells[0].x},${currentPlayer.cells[0].y})` : 'null');
}

// ========== AI玩家行为优化 ========== //
// AI追逐目标最大帧数
const AI_MAX_CHASE_TICKS = 120;

// 主动推送房间列表
function broadcastRoomList() {
    const rooms = Object.entries(activeRooms)
        .filter(([_, room]) => room.status === 'playing')
        .map(([roomId, room]) => ({
            roomId,
            playerCount: room.players.length,
            spectatorCount: room.spectators.length,
            createdAt: room.createdAt
        }));
    io.emit('room_list', rooms);
}

function getNearestEntity(from, arr) {
    let nearest = null, minDist = Infinity;
    for (const e of arr) {
        const dist = util.getDistance(from, e);
        if (dist < minDist) {
            minDist = dist;
            nearest = e;
        }
    }
    return { entity: nearest, dist: minDist };
}

function generateAISpawnpoint() {
    // 优先靠近玩家
    const players = map.players.data.filter(p => !p.isAI);
    if (players.length > 0) {
        const p = players[Math.floor(Math.random() * players.length)];
        return { x: p.x + (Math.random() - 0.5) * 200, y: p.y + (Math.random() - 0.5) * 200 };
    }
    // 其次靠近食物
    const food = map.food.data;
    if (food.length > 0) {
        const f = food[Math.floor(Math.random() * food.length)];
        return { x: f.x, y: f.y };
    }
    // 否则随机
    return getPosition(false, util.massToRadius(config.defaultPlayerMass), map.players.data);
}

function createAIPlayer(roomId) {
    // 生成唯一AI id
    const aiId = 'AI_' + (aiIdCounter++);
    const aiPlayer = new mapUtils.playerUtils.Player(aiId);
    aiPlayer.isAI = true;
    aiPlayer.name = '电脑玩家' + aiIdCounter;
    // AI出生点优化
    aiPlayer.init(generateAISpawnpoint(), config.defaultPlayerMass + 2);
    map.players.pushNew(aiPlayer);
    if (activeRooms[roomId]) {
        activeRooms[roomId].players.push(aiId);
    }
    return aiPlayer;
}

function tryMatchWithAI() {
    if (matchmakingQueue.length > 0 && matchmakingQueue.length < 3) {
        // 超时后补齐AI
        const roomId = 'room_' + (roomIdCounter++);
        const players = matchmakingQueue.splice(0, matchmakingQueue.length);
        const aiNeeded = 3 - players.length;
        activeRooms[roomId] = { players: [...players], spectators: [], status: 'playing', createdAt: Date.now() };
        // 通知真人玩家
        players.forEach(pid => {
            const psocket = io.sockets.sockets.get(pid);
            if (psocket) {
                psocket.join(roomId);
                psocket.emit('match_found', { roomId });
            }
        });
        // 创建AI玩家
        for (let i = 0; i < aiNeeded; i++) {
            createAIPlayer(roomId);
        }
        // 新增：主动推送房间列表
        broadcastRoomList();
    }
}

const tickGame = () => {
    // 先处理AI移动，确保即使玩家死亡游戏也能继续
    map.players.data.forEach(player => {
        if (player.isAI) {
            tickAIPlayer(player);
        }
        tickPlayer(player);
    });

    // 处理食物移动
    map.massFood.move(config.gameWidth, config.gameHeight);

    // 处理碰撞
    map.players.handleCollisions(function (gotEaten, eater) {
        const cellGotEaten = map.players.getCell(gotEaten.playerIndex, gotEaten.cellIndex);
        if (!cellGotEaten) {
            console.warn('cellGotEaten is undefined', gotEaten, eater);
            return;
        }

        // 更新吃掉玩家的质量
        map.players.data[eater.playerIndex].changeCellMass(eater.cellIndex, cellGotEaten.mass);

        // 移除被吃掉的细胞
        const playerDied = map.players.removeCell(gotEaten.playerIndex, gotEaten.cellIndex);

        if (playerDied) {
            let playerGotEaten = map.players.data[gotEaten.playerIndex];
            io.emit('playerDied', { name: playerGotEaten.name });

            // 如果是真实玩家，发送RIP消息
            if (!playerGotEaten.isAI) {
                sockets[playerGotEaten.id].emit('RIP');
            }

            // 从地图中移除玩家
            map.players.removePlayerByIndex(gotEaten.playerIndex);

            // 处理房间状态
            let roomId = null;
            for (const [rid, room] of Object.entries(activeRooms)) {
                if (room.players.includes(playerGotEaten.id)) {
                    roomId = rid;
                    room.players = room.players.filter(pid => pid !== playerGotEaten.id);

                    // 检查房间中剩余的玩家
                    const remainingPlayers = room.players.filter(pid => !pid.startsWith('AI_'));
                    const remainingAIs = room.players.filter(pid => pid.startsWith('AI_'));

                    // 只有当没有真实玩家且（没有观众或只剩1个AI）时才结束房间
                    if (remainingPlayers.length === 0 &&
                        (room.spectators.length === 0 || remainingAIs.length <= 1)) {
                        endRoom(roomId);
                    }
                    break;
                }
            }
        }

        // 更新排行榜
        calculateLeaderboard();
        for (const id in sockets) {
            sendLeaderboard(sockets[id]);
        }
        spectators.forEach(id => {
            if (sockets[id]) sendLeaderboard(sockets[id]);
        });
    });
};

const calculateLeaderboard = () => {
    const topPlayers = map.players.getTopPlayers();

    if (leaderboard.length !== topPlayers.length) {
        leaderboard = topPlayers;
        leaderboardChanged = true;
    } else {
        for (let i = 0; i < leaderboard.length; i++) {
            if (
                leaderboard[i].id !== topPlayers[i].id ||
                leaderboard[i].massTotal !== topPlayers[i].massTotal
            ) {
                leaderboard = topPlayers;
                leaderboardChanged = true;
                break;
            }
        }
    }
}

const gameloop = () => {
    if (map.players.data.length > 0) {
        calculateLeaderboard();
        map.players.shrinkCells(config.massLossRate, config.defaultPlayerMass, config.minMassLoss);
    }

    map.balanceMass(config.foodMass, config.gameMass, config.maxFood, config.maxVirus);
};

const sendUpdates = () => {
    spectators.forEach(updateSpectator);
    map.enumerateWhatPlayersSee(function (playerData, visiblePlayers, visibleFood, visibleMass, visibleViruses) {
        // 只给真人玩家推送
        if (sockets[playerData.id]) {
            sockets[playerData.id].emit('serverTellPlayerMove', playerData, visiblePlayers, visibleFood, visibleMass, visibleViruses);
            if (leaderboardChanged) {
                sendLeaderboard(sockets[playerData.id]);
            }
        }
    });

    leaderboardChanged = false;
};

const sendLeaderboard = (socket) => {
    socket.emit('leaderboard', {
        players: map.players.data.length,
        leaderboard
    });
}
const updateSpectator = (socketID) => {
    let playerData = {
        x: config.gameWidth / 2,
        y: config.gameHeight / 2,
        cells: [],
        massTotal: 0,
        hue: 100,
        id: socketID,
        name: ''
    };
    sockets[socketID].emit('serverTellPlayerMove', playerData, map.players.data, map.food.data, map.massFood.data, map.viruses.data);
    if (leaderboardChanged) {
        sendLeaderboard(sockets[socketID]);
    }
}

// ========== 游戏结束时清理房间 ========== //
// function endRoom(roomId) {
//     const room = activeRooms[roomId];
//     if (room) {
//         // 判断赢家（最后剩下的玩家）
//         let winnerId = null;
//         if (room.players.length === 1) {
//             winnerId = room.players[0];
//         }

//         // 如果房间中还有AI在对战，且有观众在观看，则不结束房间
//         const remainingAIs = room.players.filter(pid => pid.startsWith('AI_'));
//         if (remainingAIs.length > 1 && room.spectators.length > 0) {
//             // 只通知已死亡的玩家
//             room.players.forEach(pid => {
//                 if (!pid.startsWith('AI_')) {
//                     const psocket = io.sockets.sockets.get(pid);
//                     if (psocket) {
//                         psocket.leave(roomId);
//                         psocket.emit('room_ended', { roomId });
//                     }
//                 }
//             });
//             // 更新房间状态
//             room.players = remainingAIs;
//             // 通知观众AI继续对战
//             room.spectators.forEach(pid => {
//                 const psocket = io.sockets.sockets.get(pid);
//                 if (psocket) {
//                     psocket.emit('ai_continue', {
//                         roomId,
//                         aiCount: remainingAIs.length
//                     });
//                 }
//             });
//             return; // 不删除房间，让AI继续
//         }

//         // 如果没有观众或只剩一个AI，则正常结束房间
//         room.players.forEach(pid => {
//             const psocket = io.sockets.sockets.get(pid);
//             if (psocket) {
//                 psocket.leave(roomId);
//                 if (winnerId && pid === winnerId) {
//                     psocket.emit('win', { roomId });
//                 } else {
//                     psocket.emit('room_ended', { roomId });
//                 }
//             }
//         });
//         room.spectators.forEach(pid => {
//             const psocket = io.sockets.sockets.get(pid);
//             if (psocket) {
//                 psocket.leave(roomId);
//                 psocket.emit('room_ended', { roomId });
//             }
//         });
//         delete activeRooms[roomId];
//         // 主动推送房间列表
//         broadcastRoomList();
//     }
// }

function endRoom(roomId, winner = null) {
    const room = activeRooms[roomId];
    if (room) {
        // 判断赢家（最后剩下的玩家或超时指定的获胜者）
        let winnerId = winner ? winner.id : (room.players.length === 1 ? room.players[0] : null);

        // 如果房间中还有AI在对战，且有观众在观看，则不结束房间
        const remainingAIs = room.players.filter(pid => pid.startsWith('AI_'));
        if (remainingAIs.length > 1 && room.spectators.length > 0 && !winner) {
            // 只通知已死亡的玩家
            room.players.forEach(pid => {
                if (!pid.startsWith('AI_')) {
                    const psocket = io.sockets.sockets.get(pid);
                    if (psocket) {
                        psocket.leave(roomId);
                        psocket.emit('room_ended', { roomId });
                        // 移除非 AI 玩家
                        const playerIndex = map.players.findIndexByID(pid);
                        if (playerIndex > -1) map.players.removePlayerByIndex(playerIndex);
                    }
                }
            });
            // 更新房间状态
            room.players = remainingAIs;
            // 通知观众AI继续对战
            room.spectators.forEach(pid => {
                const psocket = io.sockets.sockets.get(pid);
                if (psocket) {
                    psocket.emit('ai_continue', {
                        roomId,
                        aiCount: remainingAIs.length
                    });
                }
            });
            return; // 不删除房间，让AI继续
        }

        // 如果没有观众或只剩一个AI，或是超时结束，则正常结束房间
        room.players.forEach(pid => {
            const psocket = io.sockets.sockets.get(pid);
            if (psocket) {
                psocket.leave(roomId);
                if (winnerId && pid === winnerId) {
                    psocket.emit('win', { roomId, winner: winner ? { name: winner.name, massTotal: winner.massTotal } : null });
                } else {
                    psocket.emit('room_ended', { roomId, winner: winner ? { name: winner.name, massTotal: winner.massTotal } : null });
                }
            }
            // 移除玩家
            const playerIndex = map.players.findIndexByID(pid);
            if (playerIndex > -1) map.players.removePlayerByIndex(playerIndex);
        });
        room.spectators.forEach(pid => {
            const psocket = io.sockets.sockets.get(pid);
            if (psocket) {
                psocket.leave(roomId);
                psocket.emit('room_ended', { roomId, winner: winner ? { name: winner.name, massTotal: winner.massTotal } : null });
            }
        });
        console.log(`[INFO] Room ${roomId} ended. Winner: ${winner ? `${winner.name} (mass: ${winner.massTotal})` : 'None'}`);
        delete activeRooms[roomId];
        broadcastRoomList();
    }
}

// AI锁定目标
function tickAIPlayer(aiPlayer) {
    if (!aiPlayer.isAI) return;
    if (!aiPlayer.cells || aiPlayer.cells.length === 0) return;

    console.log(`[AI][${aiPlayer.id}] [tickAIPlayer] 主坐标: (${aiPlayer.x},${aiPlayer.y}), cells.length: ${aiPlayer.cells.length}, cells[0]:`, aiPlayer.cells[0] ? `(${aiPlayer.cells[0].x},${aiPlayer.cells[0].y})` : 'null');

    let myRoom = null;
    for (const [rid, room] of Object.entries(activeRooms)) {
        if (room.players.includes(aiPlayer.id)) {
            myRoom = room;
            break;
        }
    }
    if (!myRoom) return;

    // 强制同步massTotal为cells质量总和
    aiPlayer.massTotal = aiPlayer.cells && aiPlayer.cells.length > 0
        ? aiPlayer.cells.reduce((sum, c) => sum + c.mass, 0)
        : config.defaultPlayerMass + 2;

    // 获取所有玩家，包括AI
    const allPlayers = map.players.data;
    const allFood = map.food.data;

    // 日志：AI和所有玩家的massTotal、坐标
    console.log(`[AI][${aiPlayer.id}] massTotal: ${aiPlayer.massTotal}, 坐标: (${aiPlayer.x},${aiPlayer.y}), cells.length: ${aiPlayer.cells ? aiPlayer.cells.length : 0}`);
    allPlayers.forEach(p => {
        if (p.id !== aiPlayer.id) {
            console.log(`[AI][${aiPlayer.id}] 其他实体(${p.id}) massTotal: ${p.massTotal}, 坐标: (${p.x},${p.y})`);
        }
    });
    console.log(`[AI][${aiPlayer.id}] 食物数: ${allFood.length}`);
    console.log(`[AI][${aiPlayer.id}] 当前target:`, aiPlayer.target);

    // ====== AI智能决策 ======
    const THREAT_DIST = 400; // 逃离阈值
    const PREY_DIST = 300;   // 追逐阈值
    const FOOD_DIST = 200;   // 食物吸引阈值

    // 1. 检查是否有威胁（更大的玩家在附近）
    const threats = allPlayers.filter(p =>
        p.id !== aiPlayer.id &&
        p.massTotal > aiPlayer.massTotal * 1.1
    );

    if (threats.length > 0) {
        const { entity: threat, dist } = getNearestEntity(aiPlayer, threats);
        if (threat && dist < THREAT_DIST) {
            // 逃离威胁
            aiPlayer.target = {
                x: aiPlayer.x + (aiPlayer.x - threat.x) * 2,
                y: aiPlayer.y + (aiPlayer.y - threat.y) * 2
            };
            console.log(`[AI][${aiPlayer.id}] 逃离 实体(${threat.id}) 距离:${dist} 目标:`, aiPlayer.target);
            return;
        }
    }

    // 2. 寻找可以吃的目标（较小的玩家）
    const preys = allPlayers.filter(p =>
        p.id !== aiPlayer.id &&
        p.massTotal * 1.1 < aiPlayer.massTotal
    );

    if (preys.length > 0) {
        const { entity: prey, dist } = getNearestEntity(aiPlayer, preys);
        if (prey && dist < PREY_DIST) {
            // 追逐猎物
            aiPlayer.target = { x: prey.x, y: prey.y };
            console.log(`[AI][${aiPlayer.id}] 追逐 实体(${prey.id}) 距离:${dist} 目标:`, aiPlayer.target);
            return;
        }
    }

    // 3. 如果没有威胁和猎物，寻找最近的食物
    if (allFood.length > 0) {
        const { entity: food, dist } = getNearestEntity(aiPlayer, allFood);
        if (food && dist < FOOD_DIST) {
            aiPlayer.target = { x: food.x, y: food.y };
            console.log(`[AI][${aiPlayer.id}] 寻找食物 距离:${dist} 目标:`, aiPlayer.target);
            return;
        }
    }

    // 4. 如果什么都没找到，随机移动
    if (!aiPlayer.target || (Math.random() < 0.05)) { // 5%概率改变方向
        const angle = Math.random() * Math.PI * 2;
        const distance = 100 + Math.random() * 200; // 随机100-300范围内的距离
        aiPlayer.target = {
            x: aiPlayer.x + Math.cos(angle) * distance,
            y: aiPlayer.y + Math.sin(angle) * distance
        };
        console.log(`[AI][${aiPlayer.id}] 随机移动 目标:`, aiPlayer.target);
    }
}

function checkRoomTimeouts() {
    const now = Date.now();
    for (const [roomId, room] of Object.entries(activeRooms)) {
        console.log(now)
        console.log(room.createdAt)
        if (now - room.createdAt >= config.gameMaxTime) {
            console.log('xxx')
            let winner = room.players.reduce((top, pid) => {
                const idx = map.players.findIndexByID(pid);
                if (idx > -1 && map.players.data[idx].massTotal > (top?.massTotal || -1)) return map.players.data[idx];
                return top;
            }, null);
            endRoom(roomId, winner);
        }
    }
}

setInterval(tickGame, 1000 / 60);
setInterval(gameloop, 1000);
setInterval(sendUpdates, 1000 / config.networkUpdateFactor);
setInterval(checkRoomTimeouts, 1000);

// Don't touch, IP configurations.
var ipaddress = process.env.OPENSHIFT_NODEJS_IP || process.env.IP || config.host;
var serverport = process.env.OPENSHIFT_NODEJS_PORT || process.env.PORT || config.port;
http.listen(serverport, ipaddress, () => console.log('[DEBUG] Listening on ' + ipaddress + ':' + serverport));
