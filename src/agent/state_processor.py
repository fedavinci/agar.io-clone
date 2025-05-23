import numpy as np

def extract_observation(me, players, foods, masses, viruses):
    # 假设提取中心点和周围5个单位的相对位置与质量
    obs = {
        'self_x': me['x'],
        'self_y': me['y'],
        'self_mass': me['massTotal'],
        'nearby_foods': [],
        'nearby_enemies': [],
    }
    foods_sorted = sorted(foods, key=lambda f: (f['x'] - me['x']) ** 2 + (f['y'] - me['y']) ** 2)
    for f in foods_sorted[:5]:
        obs['nearby_foods'].append([f['x'] - me['x'], f['y'] - me['y']])

    enemies = [p for p in players if p['id'] != me['id']]
    enemies_sorted = sorted(enemies, key=lambda p: (p['x'] - me['x']) ** 2 + (p['y'] - me['y']) ** 2)
    for p in enemies_sorted[:3]:
        obs['nearby_enemies'].append([
            p['x'] - me['x'], p['y'] - me['y'], p['massTotal']
        ])

    return obs

def format_action(action, me):
    # 例：将方向向量转换为目标坐标
    dx, dy = action  # 模型输出方向
    scale = 200
    return {'x': me['x'] + dx * scale, 'y': me['y'] + dy * scale}

