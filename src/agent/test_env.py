from demo import AgarEnvironment


def test_env():
    env = AgarEnvironment()
    
    obs = env.reset()
    print("初始 Observation:", obs)
    
    for step in range(10):
        action = env.action_space.sample()  # 随机动作
        obs, reward, done, info = env.step(action)
        
        print(f"Step {step + 1}:")
        print("  Action:", action)
        print("  Observation:", obs)
        print("  Reward:", reward)
        print("  Done:", done)
        print("  Info:", info)

        if done:
            print("  游戏结束，重置环境")
            obs = env.reset()
    
    env.close()

test_env()
