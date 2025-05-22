/*jslint bitwise: true, node: true */
'use strict';

const express = require('express');
const app = express();
const { Server } = require('socket.io');
const SAT = require('sat');

const gameLogic = require('./game-logic');
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

let io;
if (process.env.VERCEL) {
    // Vercel 环境下，使用 SocketIO 的 serverless 模式
    io = new Server({
        cors: {
            origin: "*",
            methods: ["GET", "POST"],
            credentials: true,
            transports: ['websocket', 'polling']
        },
        allowEIO3: true,
        path: '/socket.io/'
    });
} else {
    // 本地开发环境，使用传统模式
    const http = require('http').Server(app);
    io = new Server(http, {
        cors: {
            origin: "*",
            methods: ["GET", "POST"],
            credentials: true,
            transports: ['websocket', 'polling']
        },
        allowEIO3: true,
        path: '/socket.io/'
    });
}

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
    map.players.data.forEach(player => {
        if (player.isAI) {
            tickAIPlayer(player);
        }
        tickPlayer(player);
    });
    map.massFood.move(config.gameWidth, config.gameHeight);
    map.players.handleCollisions(function (gotEaten, eater) {
        const cellGotEaten = map.players.getCell(gotEaten.playerIndex, gotEaten.cellIndex);
        map.players.data[eater.playerIndex].changeCellMass(eater.cellIndex, cellGotEaten.mass);
        const playerDied = map.players.removeCell(gotEaten.playerIndex, gotEaten.cellIndex);
        if (playerDied) {
            let playerGotEaten = map.players.data[gotEaten.playerIndex];
            io.emit('playerDied', { name: playerGotEaten.name });
            if (!playerGotEaten.isAI) sockets[playerGotEaten.id].emit('RIP');
            map.players.removePlayerByIndex(gotEaten.playerIndex);
            let roomId = null;
            for (const [rid, room] of Object.entries(activeRooms)) {
                if (room.players.includes(playerGotEaten.id)) {
                    roomId = rid;
                    room.players = room.players.filter(pid => pid !== playerGotEaten.id);
                    if (room.players.length <= 1) {
                        endRoom(roomId);
                    }
                    break;
                }
            }
        }
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
function endRoom(roomId) {
    const room = activeRooms[roomId];
    if (room) {
        // 判断赢家（最后剩下的玩家）
        let winnerId = null;
        if (room.players.length === 1) {
            winnerId = room.players[0];
        }
        // 通知观众和玩家房间结束/胜利
        room.players.forEach(pid => {
            const psocket = io.sockets.sockets.get(pid);
            if (psocket) {
                psocket.leave(roomId);
                if (winnerId && pid === winnerId) {
                    psocket.emit('win', { roomId });
                } else {
                    psocket.emit('room_ended', { roomId });
                }
            }
            // 清理 AI 玩家
            if (pid.startsWith('AI_')) {
                const aiIndex = map.players.data.findIndex(p => p.id === pid);
                if (aiIndex !== -1) {
                    map.players.removePlayerByIndex(aiIndex);
                }
            }
        });
        room.spectators.forEach(pid => {
            const psocket = io.sockets.sockets.get(pid);
            if (psocket) {
                psocket.leave(roomId);
                psocket.emit('room_ended', { roomId });
            }
        });
        delete activeRooms[roomId];
        // 新增：主动推送房间列表
        broadcastRoomList();
    }
}

// AI锁定目标
function tickAIPlayer(aiPlayer) {
    if (!aiPlayer.isAI) return;
    if (!aiPlayer.cells || aiPlayer.cells.length === 0) return;
    // 日志：AI主坐标、cells.length、cells[0]坐标
    console.log(`[AI][${aiPlayer.id}] [tickAIPlayer] 主坐标: (${aiPlayer.x},${aiPlayer.y}), cells.length: ${aiPlayer.cells.length}, cells[0]:`, aiPlayer.cells[0] ? `(${aiPlayer.cells[0].x},${aiPlayer.cells[0].y})` : 'null');
    let myRoom = null;
    for (const [rid, room] of Object.entries(activeRooms)) {
        if (room.players.includes(aiPlayer.id)) {
            myRoom = room;
            break;
        }
    }
    if (!myRoom) return;

    // 1. 强制同步massTotal为cells质量总和
    aiPlayer.massTotal = aiPlayer.cells && aiPlayer.cells.length > 0
        ? aiPlayer.cells.reduce((sum, c) => sum + c.mass, 0)
        : config.defaultPlayerMass + 2;

    const allPlayers = map.players.data.filter(p => !p.isAI);
    const allFood = map.food.data;

    // 日志：AI和所有玩家的massTotal、坐标
    console.log(`[AI][${aiPlayer.id}] massTotal: ${aiPlayer.massTotal}, 坐标: (${aiPlayer.x},${aiPlayer.y}), cells.length: ${aiPlayer.cells ? aiPlayer.cells.length : 0}`);
    allPlayers.forEach(p => {
        console.log(`[AI][${aiPlayer.id}] 玩家(${p.id}) massTotal: ${p.massTotal}, 坐标: (${p.x},${p.y})`);
    });
    console.log(`[AI][${aiPlayer.id}] 食物数: ${allFood.length}`);
    console.log(`[AI][${aiPlayer.id}] 当前target:`, aiPlayer.target);

    // ====== AI智能决策 ======
    const THREAT_DIST = 400; // 逃离阈值
    const PREY_DIST = 300;   // 追逐阈值

    // 1. 逃离最近的威胁（距离近才逃）
    const threats = allPlayers.filter(p => p.massTotal > aiPlayer.massTotal);
    if (threats.length > 0) {
        const { entity: threat, dist } = getNearestEntity(aiPlayer, threats);
        if (threat && dist < THREAT_DIST) {
            aiPlayer.target = {
                x: aiPlayer.x + (aiPlayer.x - threat.x),
                y: aiPlayer.y + (aiPlayer.y - threat.y)
            };
            aiPlayer._chaseTicks = 0;
            console.log(`[AI][${aiPlayer.id}] 逃离 玩家(${threat.id}) 距离:${dist} 目标:`, aiPlayer.target);
            return;
        }
    }

    // 2. 追逐最近的猎物（距离近才追）
    const preys = allPlayers.filter(p => p.massTotal < aiPlayer.massTotal);
    if (preys.length > 0) {
        const { entity: prey, dist } = getNearestEntity(aiPlayer, preys);
        if (prey && dist < PREY_DIST) {
            aiPlayer.target = { x: prey.x, y: prey.y };
            aiPlayer._chaseTicks = 0;
            console.log(`[AI][${aiPlayer.id}] 追逐 玩家(${prey.id}) 距离:${dist} 目标:`, aiPlayer.target);
            return;
        }
    }

    // 3. 吃最近的球
    if (allFood.length > 0) {
        if (aiPlayer._chaseTicks === undefined) aiPlayer._chaseTicks = 0;
        if (aiPlayer.target) {
            aiPlayer._chaseTicks++;
            const distToTarget = Math.sqrt(Math.pow(aiPlayer.x - aiPlayer.target.x, 2) + Math.pow(aiPlayer.y - aiPlayer.target.y, 2));
            const nearFood = allFood.some(f => Math.abs(f.x - aiPlayer.target.x) < 50 && Math.abs(f.y - aiPlayer.target.y) < 50);
            console.log(`[AI][${aiPlayer.id}] 追食物tick: 坐标(${aiPlayer.x},${aiPlayer.y}) target(${aiPlayer.target.x},${aiPlayer.target.y}) 距离:${distToTarget} nearFood:${nearFood} _chaseTicks:${aiPlayer._chaseTicks}`);
            if (distToTarget < 100 || !nearFood || aiPlayer._chaseTicks > AI_MAX_CHASE_TICKS) {
                console.log(`[AI][${aiPlayer.id}] 追逐超时/目标无食物/已到达，重置target，distToTarget:${distToTarget} nearFood:${nearFood} _chaseTicks:${aiPlayer._chaseTicks}`);
                aiPlayer.target = null;
                aiPlayer._chaseTicks = 0;
            }
        }
        if (!aiPlayer.target) {
            const { entity: food, dist } = getNearestEntity(aiPlayer, allFood);
            if (food) {
                aiPlayer.target = { x: food.x, y: food.y };
                aiPlayer._chaseTicks = 0;
                console.log(`[AI][${aiPlayer.id}] 重新锁定最近食物: (${food.x},${food.y}) 距离:${dist}`);
                return;
            }
        } else {
            return;
        }
    }

    aiPlayer.target = null;
    aiPlayer._chaseTicks = 0;
    console.log(`[AI][${aiPlayer.id}] 没有目标，原地不动`);
}

setInterval(tickGame, 1000 / 60);
setInterval(gameloop, 1000);
setInterval(sendUpdates, 1000 / config.networkUpdateFactor);

// 修改导出部分
if (process.env.VERCEL) {
    module.exports = app;
    // 在 Vercel 环境中，Socket.IO 会自动附加到 app
    app.io = io;
} else {
    // 本地开发环境
    const ipaddress = process.env.IP || config.host;
    const serverport = process.env.PORT || config.port;
    http.listen(serverport, ipaddress, () => console.log('[DEBUG] Listening on ' + ipaddress + ':' + serverport));
}
