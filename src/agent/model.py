from stable_baselines3 import PPO
import numpy as np

class MyAIModel:
    def __init__(self, model_path='models/ppo_agar_agent.zip'):
        self.model = PPO.load(model_path, custom_objects={
            "clip_range": lambda x: 0.2,
            "lr_schedule": lambda x: 2.5e-4,
            "optimizer": None  # 避免加载 optimizer 导致参数冲突
        })
        print("[AI] PPO model loaded successfully.")

    def predict(self, obs_dict):
        # 你必须将 obs_dict 转换为模型训练时定义的 observation 格式
        obs = self._preprocess(obs_dict)
        action, _ = self.model.predict(obs, deterministic=True)
        return action

    def _preprocess(self, obs_dict):
        """
        将 state_processor 返回的 dict 转换为模型训练时需要的 observation 格式。
        假设你训练时使用的是一个一维向量表示的状态空间。
        """
        obs = []

        # 例如：拼接 self_x, self_y, self_mass
        obs.extend([
            obs_dict['self_x'] / 1000.0,
            obs_dict['self_y'] / 1000.0,
            obs_dict['self_mass'] / 500.0
        ])

        # 拼接 food 相对位置
        for food in obs_dict['nearby_foods']:
            obs.extend([food[0] / 100.0, food[1] / 100.0])
        while len(obs_dict['nearby_foods']) < 5:
            obs.extend([0, 0])  # 补零

        # 拼接敌人相对位置和体重
        for enemy in obs_dict['nearby_enemies']:
            obs.extend([
                enemy[0] / 100.0, enemy[1] / 100.0, enemy[2] / 500.0
            ])
        while len(obs_dict['nearby_enemies']) < 3:
            obs.extend([0, 0, 0])

        return np.array(obs, dtype=np.float32).reshape(1, -1)
