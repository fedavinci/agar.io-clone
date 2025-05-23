import socketio
import threading
import time
import numpy as np

from model import MyAIModel
from state_processor import extract_observation, format_action

# === 初始化 socket.io 客户端 ===
sio = socketio.Client()
model = MyAIModel()

# === 全局目标用于心跳线程定时发出 ===
latest_target = {'x': 100, 'y': 100}

# === 心跳线程，保持连接活跃 ===
def heartbeat_loop():
    while True:
        time.sleep(1.0)  # 每秒发送一次
        try:
            sio.emit('0', latest_target)
        except Exception as e:
            print('[AI] Heartbeat failed:', e)

# === Socket.IO 事件 ===

@sio.event
def connect():
    print('[AI] Connected to server')
    sio.emit('join_matchmaking')  # 主动加入匹配队列
    threading.Thread(target=heartbeat_loop, daemon=True).start()

@sio.on('match_found')
def on_match_found(data):
    print(f"[AI] Match found! Room ID: {data['roomId']}")
    # 加入房间后，告诉服务端我们准备好了
    sio.emit('gotit', {'name': f'py_ai_{np.random.randint(1000,9999)}'})

@sio.on('welcome')
def on_welcome(playerSettings, gameSizes):
    print('[AI] Welcome received, starting game')
    sio.emit('respawn')

@sio.on('serverTellPlayerMove')
def on_game_state(playerData, players, foods, masses, viruses):
    global latest_target
    if not playerData.get('id') or not playerData.get('cells'):
        return

    obs = extract_observation(playerData, players, foods, masses, viruses)
    action = model.predict(obs)
    latest_target = format_action(action, playerData)

    # 打印目标日志
    print(f"[AI] Acting → target: {latest_target}")

@sio.on('kick')
def on_kick(reason):
    print(f"[AI] Kicked from server: {reason}")

@sio.event
def disconnect():
    print('[AI] Disconnected from server')

# === 启动客户端 ===
if __name__ == '__main__':
    try:
        sio.connect('http://localhost:3000?type=player', transports=['websocket'])
        sio.wait()
    except Exception as e:
        print('[AI] Failed to connect:', e)
