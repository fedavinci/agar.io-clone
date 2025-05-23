// 兼容CDN和require两种加载方式
var io;
try {
    // 尝试使用全局的io（CDN加载）
    io = window.io || require('socket.io-client');
} catch (e) {
    // 如果require失败，使用全局io
    io = window.io;
}

var render = require('./render');
var ChatClient = require('./chat-client');
var Canvas = require('./canvas');
var global = require('./global');

var playerNameInput = document.getElementById('playerNameInput');
var socket;

// 修复：确保socket变量同步到window.socket
function updateGlobalSocket(newSocket) {
    socket = newSocket;
    window.socket = newSocket;
    console.log('[DEBUG] Global socket updated:', !!newSocket);
}

var debug = function (args) {
    if (console && console.log) {
        console.log(args);
    }
};

// 预声明setupSocket函数为全局变量
window.setupSocket = null;
console.log('[DEBUG] app.js loaded, will expose setupSocket when defined');

if (/Android|webOS|iPhone|iPad|iPod|BlackBerry/i.test(navigator.userAgent)) {
    global.mobile = true;
}

function startGame(type, roomId) {
    global.playerName = playerNameInput.value.replace(/(<([^>]+)>)/ig, '').substring(0, 25);
    global.playerType = type;

    global.screen.width = window.innerWidth;
    global.screen.height = window.innerHeight;

    document.getElementById('startMenuWrapper').style.maxHeight = '0px';
    document.getElementById('gameAreaWrapper').style.opacity = 1;
    if (!socket) {
        const newSocket = io({ query: "type=" + type });
        updateGlobalSocket(newSocket);
        setupSocket(newSocket);
    }
    if (!global.animLoopHandle)
        animloop();
    socket.emit('respawn');
    window.chat.socket = socket;
    window.chat.registerFunctions();
    window.canvas.socket = socket;
    global.socket = socket;
    // 观战时强制 resize，确保画布全屏
    if (type === 'spectator') {
        setTimeout(resize, 0);
    }
}

// Checks if the nick chosen contains valid alphanumeric characters (and underscores).
function validNick() {
    var regex = /^\w*$/;
    debug('Regex Test', regex.exec(playerNameInput.value));
    return regex.exec(playerNameInput.value) !== null;
}

// ========== 新增全局变量和 UI 切换函数 ========== //
var matchingWrapper = document.getElementById('matchingWrapper');
var roomListWrapper = document.getElementById('roomListWrapper');
var resultWrapper = document.getElementById('resultWrapper');
var resultMsg = document.getElementById('resultMsg');
var backToMenuBtn = document.getElementById('backToMenuBtn');

function showMainMenuUI() {
    document.getElementById('startMenuWrapper').style.maxHeight = '1000px';
    document.getElementById('gameAreaWrapper').style.opacity = 0;
    if (matchingWrapper) matchingWrapper.style.display = 'none';
    if (roomListWrapper) roomListWrapper.style.display = 'none';
    if (resultWrapper) resultWrapper.style.display = 'none';
}
function showMatchingUI(waiting) {
    if (matchingWrapper) {
        matchingWrapper.style.display = 'block';
        matchingWrapper.innerText = waiting ? `匹配中，等待${waiting}人...` : '匹配中...';
    }
    document.getElementById('startMenuWrapper').style.maxHeight = '0px';
    document.getElementById('gameAreaWrapper').style.opacity = 0;
}
function hideMatchingUI() {
    if (matchingWrapper) matchingWrapper.style.display = 'none';
}
function showRoomListUI() {
    if (roomListWrapper) roomListWrapper.style.display = 'block';
    document.getElementById('startMenuWrapper').style.maxHeight = '0px';
    document.getElementById('gameAreaWrapper').style.opacity = 0;
}
function hideRoomListUI() {
    if (roomListWrapper) roomListWrapper.style.display = 'none';
}
function showResultUI(msg) {
    if (resultWrapper) {
        resultWrapper.style.display = 'block';
        if (resultMsg) resultMsg.innerText = msg;
    }
    document.getElementById('gameAreaWrapper').style.opacity = 0;
}
function hideResultUI() {
    if (resultWrapper) resultWrapper.style.display = 'none';
}

window.onload = function () {

    var btn = document.getElementById('startButton'),
        btnS = document.getElementById('spectateButton'),
        nickErrorText = document.querySelector('#startMenu .input-error');

    btnS.onclick = function () {
        showRoomListUI();
        if (!socket) {
            const newSocket = io({ query: "type=spectator" });
            updateGlobalSocket(newSocket);
            setupSocket(newSocket);
        }
        socket.emit('get_rooms');
    };

    btn.onclick = function () {
        if (validNick()) {
            nickErrorText.style.opacity = 0;
            showMatchingUI();
            if (!socket) {
                const newSocket = io({ query: "type=player" });
                updateGlobalSocket(newSocket);
                setupSocket(newSocket);
            }
            socket.emit('join_matchmaking');
        } else {
            nickErrorText.style.opacity = 1;
        }
    };

    var settingsMenu = document.getElementById('settingsButton');
    var settings = document.getElementById('settings');

    settingsMenu.onclick = function () {
        if (settings.style.maxHeight == '300px') {
            settings.style.maxHeight = '0px';
        } else {
            settings.style.maxHeight = '300px';
        }
    };

    playerNameInput.addEventListener('keypress', function (e) {
        var key = e.which || e.keyCode;

        if (key === global.KEY_ENTER) {
            if (validNick()) {
                nickErrorText.style.opacity = 0;
                startGame('player');
            } else {
                nickErrorText.style.opacity = 1;
            }
        }
    });
};

// TODO: Break out into GameControls.

var playerConfig = {
    border: 6,
    textColor: '#FFFFFF',
    textBorder: '#000000',
    textBorderSize: 3,
    defaultSize: 30
};

var player = {
    id: -1,
    x: global.screen.width / 2,
    y: global.screen.height / 2,
    screenWidth: global.screen.width,
    screenHeight: global.screen.height,
    target: { x: global.screen.width / 2, y: global.screen.height / 2 }
};
global.player = player;

var foods = [];
var viruses = [];
var fireFood = [];
var users = [];
var leaderboard = [];
var target = { x: player.x, y: player.y };
global.target = target;

window.canvas = new Canvas();
window.chat = new ChatClient();

var visibleBorderSetting = document.getElementById('visBord');
visibleBorderSetting.onchange = settings.toggleBorder;

var showMassSetting = document.getElementById('showMass');
showMassSetting.onchange = settings.toggleMass;

var continuitySetting = document.getElementById('continuity');
continuitySetting.onchange = settings.toggleContinuity;

var roundFoodSetting = document.getElementById('roundFood');
roundFoodSetting.onchange = settings.toggleRoundFood;

var c = window.canvas.cv;
var graph = c.getContext('2d');

$("#feed").click(function () {
    socket.emit('1');
    window.canvas.reenviar = false;
});

$("#split").click(function () {
    socket.emit('2');
    window.canvas.reenviar = false;
});

function handleDisconnect() {
    socket.close();
    if (!global.kicked) { // We have a more specific error message 
        render.drawErrorMessage('Disconnected!', graph, global.screen);
    }
}

// socket stuff.
function setupSocket(socket) {
    console.log('[DEBUG] setupSocket called with socket:', socket);

    // Handle ping.
    socket.on('pongcheck', function () {
        var latency = Date.now() - global.startPingTime;
        debug('Latency: ' + latency + 'ms');
        window.chat.addSystemLine('Ping: ' + latency + 'ms');
    });

    // Handle error.
    socket.on('connect_error', handleDisconnect);
    socket.on('disconnect', handleDisconnect);

    // Handle connection.
    socket.on('welcome', function (playerSettings, gameSizes) {
        player = playerSettings;
        player.name = global.playerName;
        player.screenWidth = global.screen.width;
        player.screenHeight = global.screen.height;
        player.target = window.canvas.target;
        global.player = player;
        window.chat.player = player;
        socket.emit('gotit', player);
        global.gameStart = true;
        window.chat.addSystemLine('Connected to the game!');
        window.chat.addSystemLine('Type <b>-help</b> for a list of commands.');
        if (global.mobile) {
            document.getElementById('gameAreaWrapper').removeChild(document.getElementById('chatbox'));
        }
        c.focus();
        global.game.width = gameSizes.width;
        global.game.height = gameSizes.height;
        resize();
    });

    socket.on('playerDied', (data) => {
        const eatenName = data && typeof data.playerEatenName === 'string' ? data.playerEatenName : '';
        const player = isUnnamedCell(eatenName) ? 'An unnamed cell' : eatenName;
        window.chat.addSystemLine('{GAME} - <b>' + (player) + '</b> was eaten');
    });

    socket.on('playerDisconnect', (data) => {
        window.chat.addSystemLine('{GAME} - <b>' + (isUnnamedCell(data.name) ? 'An unnamed cell' : data.name) + '</b> disconnected.');
    });

    socket.on('playerJoin', (data) => {
        window.chat.addSystemLine('{GAME} - <b>' + (isUnnamedCell(data.name) ? 'An unnamed cell' : data.name) + '</b> joined.');
    });

    socket.on('leaderboard', (data) => {
        leaderboard = data.leaderboard;
        var status = '<span class="title">Leaderboard</span>';
        for (var i = 0; i < leaderboard.length; i++) {
            status += '<br />';
            let score = leaderboard[i].massTotal || leaderboard[i].mass || 0;
            if (leaderboard[i].id == player.id) {
                if (leaderboard[i].name.length !== 0)
                    status += `<span class="me">${i + 1}. ${leaderboard[i].name} (${score})</span>`;
                else
                    status += `<span class="me">${i + 1}. An unnamed cell (${score})</span>`;
            } else {
                if (leaderboard[i].name.length !== 0)
                    status += `${i + 1}. ${leaderboard[i].name} (${score})`;
                else
                    status += `${i + 1}. An unnamed cell (${score})`;
            }
        }
        document.getElementById('status').innerHTML = status;
    });

    socket.on('serverMSG', function (data) {
        window.chat.addSystemLine(data);
    });

    // Chat.
    socket.on('serverSendPlayerChat', function (data) {
        window.chat.addChatLine(data.sender, data.message, false);
    });

    // Handle movement.
    socket.on('serverTellPlayerMove', function (playerData, userData, foodsList, massList, virusList) {
        if (global.playerType == 'player') {
            player.x = playerData.x;
            player.y = playerData.y;
            player.hue = playerData.hue;
            player.massTotal = playerData.massTotal;
            player.cells = playerData.cells;
        }
        users = userData;
        foods = foodsList;
        viruses = virusList;
        fireFood = massList;
    });

    // Death.
    socket.on('RIP', function () {
        global.gameStart = false;
        render.drawErrorMessage('You died!', graph, global.screen);
        window.setTimeout(() => {
            document.getElementById('gameAreaWrapper').style.opacity = 0;
            document.getElementById('startMenuWrapper').style.maxHeight = '1000px';
            if (global.animLoopHandle) {
                window.cancelAnimationFrame(global.animLoopHandle);
                global.animLoopHandle = undefined;
            }
        }, 2500);
    });

    socket.on('kick', function (reason) {
        global.gameStart = false;
        global.kicked = true;
        if (reason !== '') {
            render.drawErrorMessage('You were kicked for: ' + reason, graph, global.screen);
        }
        else {
            render.drawErrorMessage('You were kicked!', graph, global.screen);
        }
        socket.close();
    });

    // ========== 修改 setupSocket，监听匹配、观战、房间、结果相关事件 ========== //
    socket.on('matching', function (data) {
        showMatchingUI(data.waiting);
    });
    socket.on('match_found', function (data) {
        hideMatchingUI();
        startGame('player', data.roomId);
    });
    socket.on('room_list', function (rooms) {
        console.log('[DEBUG] room_list event received with rooms:', rooms);
        renderRoomList(rooms);
    });
    socket.on('spectate_joined', function (data) {
        console.log('[DEBUG] spectate_joined event received:', data);
        hideRoomListUI();
        startGame('spectator', data.roomId);
    });
    socket.on('spectate_failed', function (data) {
        console.log('[DEBUG] spectate_failed event received:', data);
        alert(data.reason || '观战失败');
    });
    socket.on('room_ended', function (data) {
        showResultUI('房间已结束');
    });
    socket.on('RIP', function () {
        showResultUI('你失败了');
    });
    socket.on('win', function (data) {
        showResultUI('你赢了！');
    });
}

// 立即暴露setupSocket为全局函数
window.setupSocket = setupSocket;
console.log('[DEBUG] setupSocket function exposed globally');

const isUnnamedCell = (name) => name.length < 1;

const getPosition = (entity, player, screen) => {
    return {
        x: entity.x - player.x + screen.width / 2,
        y: entity.y - player.y + screen.height / 2
    }
}

window.requestAnimFrame = (function () {
    return window.requestAnimationFrame ||
        window.webkitRequestAnimationFrame ||
        window.mozRequestAnimationFrame ||
        window.msRequestAnimationFrame ||
        function (callback) {
            window.setTimeout(callback, 1000 / 60);
        };
})();

window.cancelAnimFrame = (function (handle) {
    return window.cancelAnimationFrame ||
        window.mozCancelAnimationFrame;
})();

function animloop() {
    global.animLoopHandle = window.requestAnimFrame(animloop);
    gameLoop();
}

function gameLoop() {
    if (global.gameStart) {
        graph.fillStyle = global.backgroundColor;
        graph.fillRect(0, 0, global.screen.width, global.screen.height);

        render.drawGrid(global, player, global.screen, graph);
        foods.forEach(food => {
            let position = getPosition(food, player, global.screen);
            render.drawFood(position, food, graph);
        });
        fireFood.forEach(fireFood => {
            let position = getPosition(fireFood, player, global.screen);
            render.drawFireFood(position, fireFood, playerConfig, graph);
        });
        viruses.forEach(virus => {
            let position = getPosition(virus, player, global.screen);
            render.drawVirus(position, virus, graph);
        });


        let borders = { // Position of the borders on the screen
            left: global.screen.width / 2 - player.x,
            right: global.screen.width / 2 + global.game.width - player.x,
            top: global.screen.height / 2 - player.y,
            bottom: global.screen.height / 2 + global.game.height - player.y
        }
        if (global.borderDraw) {
            render.drawBorder(borders, graph);
        }

        var cellsToDraw = [];
        for (var i = 0; i < users.length; i++) {
            let color = 'hsl(' + users[i].hue + ', 100%, 50%)';
            let borderColor = 'hsl(' + users[i].hue + ', 100%, 45%)';
            for (var j = 0; j < users[i].cells.length; j++) {
                cellsToDraw.push({
                    color: color,
                    borderColor: borderColor,
                    mass: users[i].cells[j].mass,
                    name: users[i].name,
                    radius: users[i].cells[j].radius,
                    x: users[i].cells[j].x - player.x + global.screen.width / 2,
                    y: users[i].cells[j].y - player.y + global.screen.height / 2
                });
            }
        }
        cellsToDraw.sort(function (obj1, obj2) {
            return obj1.mass - obj2.mass;
        });
        render.drawCells(cellsToDraw, playerConfig, global.toggleMassState, borders, graph);

        socket.emit('0', window.canvas.target); // playerSendTarget "Heartbeat".
    }
}

window.addEventListener('resize', resize);

function resize() {
    if (!socket) return;

    player.screenWidth = c.width = global.screen.width = global.playerType == 'player' ? window.innerWidth : global.game.width;
    player.screenHeight = c.height = global.screen.height = global.playerType == 'player' ? window.innerHeight : global.game.height;

    if (global.playerType == 'spectator') {
        player.x = global.game.width / 2;
        player.y = global.game.height / 2;
    }

    socket.emit('windowResized', { screenWidth: global.screen.width, screenHeight: global.screen.height });
}

// ========== 渲染房间列表和观战按钮 ========== //
function renderRoomList(rooms) {
    console.log('[DEBUG] renderRoomList called with rooms:', rooms);
    console.log('[DEBUG] roomListWrapper element:', roomListWrapper);

    if (!roomListWrapper) return;
    // 先清空，防止事件重复绑定
    roomListWrapper.innerHTML = '';
    roomListWrapper.innerHTML += '<h3>正在进行中的房间</h3>';
    if (rooms.length === 0) {
        roomListWrapper.innerHTML += '<div>暂无房间</div>';
    } else {
        rooms.forEach(room => {
            const div = document.createElement('div');
            div.className = 'room-item';
            div.innerHTML = `房间号: ${room.roomId} | 玩家: ${room.playerCount}/3 | 观众: ${room.spectatorCount} <button class="spectateBtn" data-room="${room.roomId}">观战</button>`;
            roomListWrapper.appendChild(div);
        });
        // 绑定观战按钮事件
        Array.from(document.getElementsByClassName('spectateBtn')).forEach(btn => {
            btn.onclick = function () {
                const roomId = this.getAttribute('data-room');
                console.log('[DEBUG] Spectate button clicked for room:', roomId);

                // 修复：使用全局window.socket而不是局部socket
                const currentSocket = window.socket || socket;
                console.log('[DEBUG] Socket exists:', !!currentSocket);
                console.log('[DEBUG] Socket connected:', currentSocket ? currentSocket.connected : false);
                console.log('[DEBUG] window.socket exists:', !!window.socket);
                console.log('[DEBUG] local socket exists:', !!socket);

                if (currentSocket && currentSocket.connected) {
                    console.log('[DEBUG] Emitting spectate_room event');
                    currentSocket.emit('spectate_room', { roomId });
                } else if (currentSocket && !currentSocket.connected) {
                    console.log('[DEBUG] Socket exists but not connected, waiting...');
                    this.innerText = '连接中...';
                    this.disabled = true;

                    // 等待连接完成
                    const waitForConnection = () => {
                        if (currentSocket.connected) {
                            console.log('[DEBUG] Socket connected, now emitting spectate_room');
                            currentSocket.emit('spectate_room', { roomId });
                            this.innerText = '观战';
                            this.disabled = false;
                        } else {
                            setTimeout(waitForConnection, 100);
                        }
                    };
                    waitForConnection();
                } else {
                    console.error('[ERROR] No socket connection for spectating');
                    console.error('[ERROR] window.socket:', window.socket);
                    console.error('[ERROR] local socket:', socket);
                    alert('正在连接服务器，请稍后再试');
                }
            };
        });
    }
    // 返回主界面按钮
    const backBtn = document.createElement('button');
    backBtn.innerText = '返回主界面';
    backBtn.onclick = function () {
        // 断开观战 socket，防止状态混乱
        if (socket && global.playerType === 'spectator') {
            socket.disconnect();
            socket = null;
        }
        // 发送消息给父页面，让父页面处理导航
        if (window.parent && window.parent !== window) {
            window.parent.postMessage({ action: 'back_to_home' }, '*');
        } else {
            // 如果不是在iframe中，直接导航到首页
            window.location.href = '/';
        }
    };
    roomListWrapper.appendChild(backBtn);
}

// ========== 结果界面返回主界面按钮事件 ========== //
if (backToMenuBtn) {
    backToMenuBtn.onclick = function () {
        // 断开观战 socket，防止状态混乱
        if (socket && global.playerType === 'spectator') {
            socket.disconnect();
            socket = null;
        }
        // 发送消息给父页面，让父页面处理导航
        if (window.parent && window.parent !== window) {
            window.parent.postMessage({ action: 'back_to_home' }, '*');
        } else {
            // 如果不是在iframe中，直接导航到首页
            window.location.href = '/';
        }
    };
}
