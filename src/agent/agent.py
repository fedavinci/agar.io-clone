import socketio
import time
import numpy as np

from model import MyAIModel
from state_processor import extract_observation, format_action

sio = socketio.Client()
model = MyAIModel()

@sio.event
def connect():
    print('[AI] Connected')
    # 表示身份为玩家，连接成功后主动请求加入匹配
    sio.emit('join_matchmaking')

@sio.on('match_found')
def on_match_found(data):
    print(f"[AI] Match found! Room ID: {data['roomId']}")
    # 进入房间后，respawn
    sio.emit('gotit', {'name': f'py_ai_{np.random.randint(1000,9999)}'})

@sio.on('welcome')
def on_welcome(playerSettings, gameSizes):
    print('[AI] Welcome received from game server')
    # 游戏正式开始
    sio.emit('respawn')

@sio.on('serverTellPlayerMove')
def on_game_state(playerData, players, foods, masses, viruses):
    if not playerData.get('id') or not playerData.get('cells'):
        return
    obs = extract_observation(playerData, players, foods, masses, viruses)
    action = model.predict(obs)
    act = format_action(action, playerData)
    sio.emit('0', act)

@sio.event
def disconnect():
    print('[AI] Disconnected')

if __name__ == '__main__':
    sio.connect('http://localhost:3000?type=player', transports=['websocket'])
    sio.wait()
