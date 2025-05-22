from agent import AIAgent
from env import AgarEnvironment
import time

agent = AIAgent("models/ppo_agar_agent.zip")
env = AgarEnvironment()

obs = env.reset()  # ✅ 已经是 np.array，不是 dict
done = False
total_reward = 0
step = 0

while not done:
    action = agent.act(obs)  # ✅ 直接传给 agent
    obs, reward, done, info = env.step(action)
    total_reward += reward
    step += 1

    print(f"Step: {step} | Action: {action} | Reward: {reward:.2f} | Mass: {info['player_mass']:.2f}")
    env.render()
    time.sleep(0.05)

print(f"\n✅ AI 玩完一局，总奖励: {total_reward:.2f}")