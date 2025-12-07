import nlpcloud
import os

# 强烈建议使用环境变量来存储你的 API token，而不是直接写在代码里
# API_TOKEN = os.getenv("NLP_CLOUD_TOKEN") 
# 如果你没有设置环境变量，可以直接替换下面的字符串
API_TOKEN = "e0e2d1607754e6f2217bc502d0f989aab6ef1642" # ！！替换成你的真实 API token

# 1. 使用具体的模型名称，而不是任务名
# 2. 将 gpu 参数改为 False 来进行测试
client = nlpcloud.Client("zho_Hans/distilbert-base-uncased-emotion", API_TOKEN, gpu=False)

text = "我喜欢你"
try:
    response = client.sentiment(text)
    print(response)
    # print(f"Sentiment: {response['scored_labels'][0]['label']}")
    # print(f"Score: {response['scored_labels'][0]['score']}")
except Exception as e:
    print(f"An error occurred: {e}")

