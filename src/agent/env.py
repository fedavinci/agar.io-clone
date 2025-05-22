import math  
import random  
import numpy as np
import gym
from gym import spaces

from typing import Dict, List, Tuple, Any, Optional  
  
class Cell:  
    def __init__(self, x, y, mass, radius, player_id):  
        self.x = x  
        self.y = y  
        self.mass = mass  
        self.radius = radius  
        self.player_id = player_id  
      
    def to_circle(self):  
        """转换为圆形，用于碰撞检测"""  
        return {'x': self.x, 'y': self.y, 'r': self.radius}  
  
class Player:  
    def __init__(self, player_id, name, x, y, mass):  
        self.id = player_id  
        self.name = name  
        self.x = x  
        self.y = y  
        self.cells = [Cell(x, y, mass, self._mass_to_radius(mass), player_id)]  
        self.massTotal = mass  
        self.target = {'x': x, 'y': y}  
        self.screenWidth = 1920  
        self.screenHeight = 1080  
        self.hue = random.randint(0, 360)  
      
    def _mass_to_radius(self, mass):  
        """质量转换为半径"""  
        return 4 + math.sqrt(mass) * 6  
      
    def move(self, slow_base, game_width, game_height):  
        """移动玩家的所有细胞"""  
        if len(self.cells) > 1:  
            # 处理细胞合并逻辑  
            pass  
          
        x_sum = 0  
        y_sum = 0  
        for cell in self.cells:  
            # 简化的移动逻辑  
            dx = self.target['x'] - cell.x  
            dy = self.target['y'] - cell.y  
              
            dist = math.sqrt(dx * dx + dy * dy)  
            if dist < 1:  
                continue  
                  
            # 速度与质量成反比  
            speed = max(slow_base, 6.25 / math.sqrt(cell.mass))  
              
            # 标准化方向向量  
            dx /= dist  
            dy /= dist  
              
            # 更新位置  
            cell.x += dx * speed  
            cell.y += dy * speed  
              
            # 边界检查  
            cell.x = max(cell.radius, min(game_width - cell.radius, cell.x))  
            cell.y = max(cell.radius, min(game_height - cell.radius, cell.y))  
              
            x_sum += cell.x  
            y_sum += cell.y  
          
        # 更新玩家位置为所有细胞的平均位置  
        self.x = x_sum / len(self.cells)  
        self.y = y_sum / len(self.cells)  
      
    def split(self, limit_split, min_mass):  
        """玩家分裂"""  
        if len(self.cells) >= limit_split:  
            return  
          
        new_cells = []  
        for cell in self.cells:  
            if cell.mass < min_mass * 2:  
                continue  
                  
            # 分裂细胞  
            new_mass = cell.mass / 2  
            cell.mass = new_mass  
            cell.radius = self._mass_to_radius(new_mass)  
              
            # 创建新细胞  
            dx = self.target['x'] - cell.x  
            dy = self.target['y'] - cell.y  
            dist = math.sqrt(dx * dx + dy * dy)  
              
            if dist < 1:  
                dx = 1  
                dy = 0  
            else:  
                dx /= dist  
                dy /= dist  
              
            new_cell = Cell(  
                cell.x + dx * cell.radius * 2,  
                cell.y + dy * cell.radius * 2,  
                new_mass,  
                self._mass_to_radius(new_mass),  
                self.id  
            )  
            new_cells.append(new_cell)  
          
        self.cells.extend(new_cells)  
        self.massTotal = sum(cell.mass for cell in self.cells)  
      
    def eject_mass(self, fire_food):  
        """射出质量"""  
        min_cell_mass = 20 + fire_food  # 假设默认质量为20  
        for i, cell in enumerate(self.cells):  
            if cell.mass >= min_cell_mass:  
                cell.mass -= fire_food  
                cell.radius = self._mass_to_radius(cell.mass)  
                # 返回射出的质量信息  
                return {  
                    'x': cell.x,  
                    'y': cell.y,  
                    'mass': fire_food,  
                    'direction': {'x': self.target['x'] - cell.x, 'y': self.target['y'] - cell.y}  
                }  
        return None  
  
class Food:  
    def __init__(self, x, y, mass=1):  
        self.x = x  
        self.y = y  
        self.mass = mass  
        self.radius = 4  # 食物半径固定  
  
class Virus:  
    def __init__(self, x, y, mass=100):  
        self.x = x  
        self.y = y  
        self.mass = mass  
        self.radius = 4 + math.sqrt(mass) * 6  
  
class AgarEnvironment(gym.Env):  
    def __init__(self, config=None):  
        """初始化环境"""  
        self.config = config or {  
            'gameWidth': 500,  
            'gameHeight': 500,  
            'defaultPlayerMass': 20,  
            'fireFood': 10,  
            'limitSplit': 16,  
            'maxFood': 500,  
            'maxViruses': 10,  
            'foodMass': 1,  
            'virusMass': 100,  
            'slowBase': 4.5,  
            'foodUniformDisposition': False,  
            'newPlayerInitialPosition': 'farthest'  
        }  
        # 游戏实体  
        self.food = []  
        self.viruses = []  
        self.players = []  
        self.mass_food = []  
          
        # AI控制的玩家  
        self.agent_player = None  
          
        # 游戏状态  
        self.steps = 0  
        self.max_steps = 20000  
        self.total_reward = 0  
          
        # 随机数生成器  
        self.rng = np.random.RandomState()
        self.observation_space = spaces.Box(low=-1, high=1, shape=(22,), dtype=np.float32)
        self.action_space = spaces.Box(low=np.array([-1, -1, 0, 0]), high=np.array([1, 1, 1, 1]), dtype=np.float32)
      
    def reset(self):  
        """重置环境"""  
        self.food = []  
        self.viruses = []  
        self.players = []  
        self.mass_food = []  
          
        # 初始化食物  
        self._init_food(self.config['maxFood'])  
          
        # 初始化病毒  
        self._init_viruses(self.config['maxViruses'])  
          
        # 初始化其他玩家（简单AI）  
        self._init_other_players(3)  # 5个其他玩家  
          
        # 初始化AI控制的玩家  
        spawn_point = self._generate_spawn_point()  
        self.agent_player = Player(  
            'agent',  
            'AI Agent',  
            spawn_point['x'],  
            spawn_point['y'],  
            self.config['defaultPlayerMass']  
        )  
          
        self.steps = 0  
        self.total_reward = 0  
          
        # 返回初始观察  
        return self._get_observation()  
      
    def step(self, action):  
        """执行一步环境交互  
          
        参数:  
            action: [target_x, target_y, split, eject]  
                target_x, target_y: 目标位置的相对坐标 (-1到1)  
                split: 是否分裂 (0或1)  
                eject: 是否射出质量 (0或1)  
          
        返回:  
            observation: 观察状态  
            reward: 奖励  
            done: 是否结束  
            info: 额外信息  
        """  
        self.steps += 1  
        if self.steps < 2000:
            action = self._rule_based_action()
        # 解析动作  
        target_x_rel, target_y_rel, split, eject = action  
          
        # 将相对坐标转换为绝对坐标  
        view_distance = 1000  # 视野范围  
        target_x = self.agent_player.x + target_x_rel * view_distance  
        target_y = self.agent_player.y + target_y_rel * view_distance  
          
        # 更新玩家目标  
        self.agent_player.target = {'x': target_x, 'y': target_y}  
          
        # 处理分裂  
        if split > 0.5:  # 二值化  
            self.agent_player.split(  
                self.config['limitSplit'],  
                self.config['defaultPlayerMass']  
            )  
          
        # 处理射出质量  
        ejected_mass = None  
        if eject > 0.5:  # 二值化  
            ejected_mass = self.agent_player.eject_mass(self.config['fireFood'])  
            if ejected_mass:  
                self.mass_food.append(ejected_mass)  
          
        # 记录之前的质量  
        prev_mass = self.agent_player.massTotal  
          
        # 更新所有实体  
        self._update_all_entities()  
          
        # 检查碰撞  
        self._check_collisions()  
          
        # 计算奖励  
        reward = self._calculate_reward(prev_mass)  
        self.total_reward += reward  
          
        # 检查游戏是否结束  
        done = self._is_done()  
                
        target_x_rel = float(np.clip(target_x_rel, -1, 1))
        target_y_rel = float(np.clip(target_y_rel, -1, 1))
        split = 1 if split > 0.5 else 0
        eject = 1 if eject > 0.5 else 0

        # 返回观察、奖励、是否结束、额外信息  
        return self._get_observation(), reward, done, {  
            'steps': self.steps,  
            'total_reward': self.total_reward,  
            'player_mass': self.agent_player.massTotal  
        }  
      
    def _rule_based_action(self):
        """模仿 JavaScript bot 的简单策略，返回动作向量 [dx, dy, split, eject]"""
        player = self.agent_player
        food_list = self.food
        enemies = self.players

        # 寻找最近食物
        nearest_food = None
        min_dist = float('inf')
        for food in food_list:
            dist = math.sqrt((player.x - food.x)**2 + (player.y - food.y)**2)
            if dist < min_dist:
                min_dist = dist
                nearest_food = food

        if nearest_food:
            dx = nearest_food.x - player.x
            dy = nearest_food.y - player.y
            norm = math.sqrt(dx**2 + dy**2) + 1e-6
            return [dx / norm, dy / norm, 0.0, 0.0]

        # 没有食物就不动
        return [0.0, 0.0, 0.0, 0.0]


    def render(self, mode='human'):  
        """渲染当前环境状态"""  
        # 这里可以实现简单的可视化  
        # 如果需要GUI，可以使用pygame等库  
        print(f"Step: {self.steps}, Mass: {self.agent_player.massTotal}, Reward: {self.total_reward}")  
      
    def _init_food(self, count):  
        """初始化食物"""  
        for _ in range(count):  
            x = self.rng.uniform(0, self.config['gameWidth'])  
            y = self.rng.uniform(0, self.config['gameHeight'])  
            self.food.append(Food(x, y, self.config['foodMass']))  
      
    def _init_viruses(self, count):  
        """初始化病毒"""  
        for _ in range(count):  
            x = self.rng.uniform(0, self.config['gameWidth'])  
            y = self.rng.uniform(0, self.config['gameHeight'])  
            self.viruses.append(Virus(x, y, self.config['virusMass']))  
      
    def _init_other_players(self, count):  
        """初始化其他玩家"""  
        for i in range(count):  
            spawn_point = self._generate_spawn_point()  
            player = Player(  
                f'bot_{i}',  
                f'Bot {i}',  
                spawn_point['x'],  
                spawn_point['y'],  
                self.config['defaultPlayerMass']  
            )  
            self.players.append(player)  
      
    def _generate_spawn_point(self):  
        """生成出生点"""  
        # 简单实现：随机位置  
        radius = 4 + math.sqrt(self.config['defaultPlayerMass']) * 6  
        x = self.rng.uniform(radius, self.config['gameWidth'] - radius)  
        y = self.rng.uniform(radius, self.config['gameHeight'] - radius)  
        return {'x': x, 'y': y}  
      
    def _update_all_entities(self):  
        """更新所有实体"""  
        # 更新AI控制的玩家  
        self.agent_player.move(  
            self.config['slowBase'],  
            self.config['gameWidth'],  
            self.config['gameHeight']  
        )  
          
        # 更新其他玩家（简单AI行为）  
        for player in self.players:  
            # 简单AI：随机移动或追逐食物  
            if self.rng.random() < 0.05:  # 5%概率随机移动  
                player.target = {  
                    'x': self.rng.uniform(0, self.config['gameWidth']),  
                    'y': self.rng.uniform(0, self.config['gameHeight'])  
                }  
            else:  
                # 找到最近的食物  
                closest_food = None  
                min_dist = float('inf')  
                for food in self.food:  
                    dist = math.sqrt((player.x - food.x)**2 + (player.y - food.y)**2)  
                    if dist < min_dist:  
                        min_dist = dist  
                        closest_food = food  
                  
                if closest_food:  
                    player.target = {'x': closest_food.x, 'y': closest_food.y}  
              
            # 移动玩家  
            player.move(  
                self.config['slowBase'],  
                self.config['gameWidth'],  
                self.config['gameHeight']  
            )
        mass_decay_rate = 0.002  # 每步衰减0.2%  
        for player in [self.agent_player] + self.players:  
            for cell in player.cells:  
                if cell.mass > self.config['defaultPlayerMass'] * 1.1:  # 只有当质量足够大时才衰减  
                    decay = cell.mass * mass_decay_rate  
                    cell.mass -= decay  
                    cell.radius = player._mass_to_radius(cell.mass)  
            player.massTotal = sum(cell.mass for cell in player.cells)
      
    def _check_collisions(self):  
        """检查碰撞"""  
        # 检查AI玩家与食物的碰撞  
        self._check_player_food_collision(self.agent_player)  
          
        # 检查其他玩家与食物的碰撞  
        for player in self.players:  
            self._check_player_food_collision(player)  
          
        # 检查玩家之间的碰撞  
        self._check_players_collision()  
          
        # 检查玩家与病毒的碰撞  
        self._check_player_virus_collision(self.agent_player)  
        for player in self.players:  
            self._check_player_virus_collision(player)
        # 添加食物再生逻辑  
        food_deficit = self.config['maxFood'] - len(self.food)  
        if food_deficit > 0:  
            self._init_food(min(food_deficit, 10))  # 每步最多生成10个新食物
      
    def _check_player_food_collision(self, player):  
        """检查玩家与食物的碰撞"""  
        for cell in player.cells:  
            food_to_remove = []  
            for i, food in enumerate(self.food):  
                dist = math.sqrt((cell.x - food.x)**2 + (cell.y - food.y)**2)  
                if dist < cell.radius:  # 碰撞  
                    cell.mass += food.mass  
                    cell.radius = player._mass_to_radius(cell.mass)  
                    food_to_remove.append(i)  
            
            # 移除被吃掉的食物  
            for i in sorted(food_to_remove, reverse=True):  
                self.food.pop(i)  
            
            # 更新玩家总质量  
            player.massTotal = sum(cell.mass for cell in player.cells)  

    def _check_players_collision(self):
        """检查玩家之间的碰撞"""
        cells_to_remove = []  # 延迟删除列表

        for i, player1 in enumerate(self.players + [self.agent_player]):
            for j, player2 in enumerate(self.players + [self.agent_player]):
                if i == j:
                    continue

                for cell1 in player1.cells[:]:
                    for cell2 in player2.cells[:]:
                        dist = math.sqrt((cell1.x - cell2.x)**2 + (cell1.y - cell2.y)**2)

                        if dist < cell1.radius + cell2.radius:
                            if cell1.mass > cell2.mass * 1.1:
                                cell1.mass += cell2.mass
                                cell1.radius = player1._mass_to_radius(cell1.mass)
                                if cell2 in player2.cells:
                                    player2.cells.remove(cell2)

                                player1.massTotal = sum(c.mass for c in player1.cells)
                                player2.massTotal = sum(c.mass for c in player2.cells)

                                if len(player2.cells) == 0 and player2 != self.agent_player:
                                    self.players.remove(player2)
                                break

                            elif cell2.mass > cell1.mass * 1.1:
                                cell2.mass += cell1.mass
                                cell2.radius = player2._mass_to_radius(cell2.mass)

                                if cell1 in player1.cells:  # ✅ 安全检查
                                    player1.cells.remove(cell1)

                                player1.massTotal = sum(c.mass for c in player1.cells)
                                player2.massTotal = sum(c.mass for c in player2.cells)

                                if len(player1.cells) == 0 and player1 != self.agent_player:
                                    self.players.remove(player1)
                                break

    def _check_player_virus_collision(self, player):   
        viruses_to_remove = []  
        
        for i, virus in enumerate(self.viruses):  
            for cell_idx, cell in enumerate(player.cells[:]):  # 创建副本以避免在迭代时修改  
                # 计算距离  
                dist = math.sqrt((cell.x - virus.x)**2 + (cell.y - virus.y)**2)  
                
                # 检查是否碰撞  
                if dist < cell.radius + virus.radius:  
                    # 只有当细胞比病毒大时才会被感染  
                    if cell.mass > virus.mass:  
                        # 分裂细胞（模拟病毒感染）  
                        if len(player.cells) < self.config['limitSplit']:  
                            # 分裂成多个小细胞  
                            new_cells = []  
                            split_count = min(4, int(cell.mass / self.config['defaultPlayerMass']))  
                            
                            if split_count > 1:  
                                # 移除原始细胞  
                                player.cells.remove(cell)  
                                
                                # 创建新的小细胞  
                                for _ in range(split_count):  
                                    new_mass = cell.mass / split_count  
                                    angle = 2 * math.pi * self.rng.random()  
                                    
                                    new_cell = Cell(  
                                        cell.x + math.cos(angle) * cell.radius,  
                                        cell.y + math.sin(angle) * cell.radius,  
                                        new_mass,  
                                        player._mass_to_radius(new_mass),  
                                        player.id  
                                    )  
                                    new_cells.append(new_cell)  
                                
                                # 添加新细胞  
                                player.cells.extend(new_cells)  
                                
                                # 更新玩家总质量  
                                player.massTotal = sum(c.mass for c in player.cells)  
                                
                                # 移除病毒  
                                viruses_to_remove.append(i)  
                                break  
        
        # 移除被消耗的病毒  
        for i in sorted(viruses_to_remove, reverse=True):  
            self.viruses.pop(i)  
            
        # 如果病毒数量低于最大值，有一定概率生成新病毒  
        if len(self.viruses) < self.config['maxViruses'] and self.rng.random() < 0.1:  
            self._init_viruses(1)  
    
    def _calculate_reward(self, prev_mass):
        """改进版奖励函数"""

        reward = 0.0

        # 成长奖励：每增长 1 点质量，奖励 0.2（你可以调成 1.0 看更快反馈）
        delta_mass = self.agent_player.massTotal - prev_mass
        reward += delta_mass * 0.5

        # 存活奖励：每一步都给 0.05
        reward += 0.05

        return reward

    def _is_done(self):  
        """检查游戏是否结束"""  
        # 游戏结束条件：  
        # 1. 达到最大步数  
        # 2. AI玩家死亡（没有细胞）  
        # 3. AI玩家是唯一存活的玩家  
        
        if self.steps >= self.max_steps:  
            return True  
        
        if len(self.agent_player.cells) == 0:  
            return True  
        
        if len(self.players) == 0:  
            return True  
        
        return False  
    
    def _get_observation(self):  
        obs = []

        # 玩家自身信息
        obs.extend([self.agent_player.x / 5000, self.agent_player.y / 5000, self.agent_player.massTotal / 500])  # 归一化

        # 记录前5个食物（x, y 相对坐标）
        for food in self.food[:5]:
            dx = (food.x - self.agent_player.x) / 1000
            dy = (food.y - self.agent_player.y) / 1000
            obs.extend([dx, dy])
        while len(obs) < 3 + 5 * 2:  # 不足补0
            obs.extend([0, 0])

        # 记录前3个敌人（x, y, mass）
        for player in self.players[:3]:
            dx = (player.x - self.agent_player.x) / 1000
            dy = (player.y - self.agent_player.y) / 1000
            dm = player.massTotal / 500
            obs.extend([dx, dy, dm])
        while len(obs) < 3 + 5*2 + 3*3:
            obs.extend([0, 0, 0])

        return np.array(obs, dtype=np.float32)