# 视觉理解与媒体生成（Vision & Media）

## 适用场景
- 看图/读图/识别内容、修图。
- 生成图片/视频/音乐/PPT/思维导图/网页转应用。

## 工作流
1. 理解类优先用专用工具
   - 读图：`local__image_vision_read`
   - 读视频：`local__video_vision_read`
   - 转录：`local__av_transcribe`
2. 生成类按目标最小化输入
   - 生成图片：`local__image_draw`
   - 视频生成/图转视频：`local__video_generate` / `local__image_to_video`
   - 音乐生成：`local__suno_music_generate`
   - PPT：`local__ppt_gen`
   - 思维导图：`local__mindmap_gen`
3. 输出原则
   - 参数/提示词要服务“成品”，不要输出长篇故事化内容。

## 参数/约束
- 路径/URL 必须来自上下文或工具返回。
