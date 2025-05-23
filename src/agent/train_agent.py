from stable_baselines3 import PPO
from env import AgarEnvironment
from stable_baselines3.common.vec_env import DummyVecEnv
import os

# 初始化环境
env = DummyVecEnv([lambda: AgarEnvironment()])

# 创建 PPO 模型
model = PPO(
    policy="MlpPolicy",
    env=env,
    verbose=1,
    tensorboard_log="./tensorboard_logs",  # 可视化训练过程
)

# 开始训练
model.learn(total_timesteps=100_000)  # 可以调成 1_000_000

# 保存模型
os.makedirs("models", exist_ok=True)
model.save("models/ppo_agar_agent")

print("✅ 训练完成，模型已保存。")
