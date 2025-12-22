import React from 'react';
import {
  FcFolder,
  FcSettings,
  FcImageFile,
  FcVideoFile,
  FcAudioFile,
  FcDocument,
  FcGlobe,
  FcSearch,
  FcMindMap,
  FcPicture,
  FcMusic,
  FcStart,
  FcAndroidOs,
  FcContacts,
  FcSms,
  FcClock,
  FcHome
} from 'react-icons/fc';
import { WiDaySunny } from 'react-icons/wi';
import {
  IoLogoGithub,
  IoLogoYoutube,
  IoChatbubbles,
  IoPeople,
  IoPerson,
  IoApps,
  IoServer,
  IoDocumentText,
  IoCloudDownload,
  IoFolderOpen
} from 'react-icons/io5';
import { BsRobot } from 'react-icons/bs';

// Helper to wrap icon in a macOS style app shape
export const AppIconWrapper = ({
  children,
  color = '#fff',
  bg = 'linear-gradient(180deg, #ffffff 0%, #f0f0f0 100%)',
  shadow = '0 2px 5px rgba(0,0,0,0.1), inset 0 1px 0 rgba(255,255,255,0.4)'
}: {
  children: React.ReactNode,
  color?: string,
  bg?: string,
  shadow?: string
}) => (
  <div style={{
    width: '100%',
    height: '100%',
    borderRadius: '22%',
    background: bg,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: shadow,
    color: color,
    fontSize: '2.5em'
  }}>
    {children}
  </div>
);

export const getDisplayName = (name: string): string => {
  const n = name.toLowerCase();
  const mapping: Record<string, string> = {
    '.': '对话配置',
    'sentra-config-ui': 'WebUI配置',
    'dev-center': '开发中心',
    'utils/emoji-stickers': '表情包配置',
    'agent-presets': '预设撰写',
    'presets-editor': '预设撰写',
    'preset-importer': '预设导入',
    'file-manager': '文件管理',
    'redis-editor': 'Redis编辑器',
    'av_transcribe': '音频转录',
    'mindmap_gen': '思维导图',
    'custom_music_card': '自定义音卡',
    'desktop_control': '桌面自动化',
    'document_read': '文档读取',
    'html_to_app': '应用制作',
    'image_vision_read': '读图',
    'music_card': '发送音卡',
    'qq_account_getqqprofile': 'QQ资料获取',
    'qq_account_setqqavatar': 'QQ设置头像',
    'qq_account_setqqprofile': 'QQ资料设置',
    'qq_account_setselflongnick': 'QQ设置签名',
    'qq_avatar_get': 'QQ获取头像',
    'qq_group_ban': 'QQ群聊禁言',
    'sentra-prompts': '提示词工程',
    'sentra-mcp': 'MCP工具服务',
    'sentra-emo': '情感引擎',
    'sentra-adapter': '适配器',
    'sentra-adapter/napcat': 'Napcat适配器',
    'sentra-rag': '知识库RAG',
    'bilibili_search': 'B站搜索',
    'github_repo_info': 'GitHub项目鉴别',
    'image_search': '以文搜图',
    'web': '网页浏览',
    'image_draw': '图像生成',
    'image_vision_edit': '图像编辑',
    'music_gen': '音乐生成',
    'suno': 'Suno 音乐',
    'qq_group_info': 'QQ群详细',
    'qq_group_kick': 'QQ群踢人',
    'qq_group_leave': 'QQ退群',
    'qq_group_list': 'QQ群列表',
    'qq_group_memberinfo': 'QQ获取群员',
    'qq_group_memberlist': 'QQ群员列表',
    'qq_group_setcard': 'QQ设置群昵称',
    'qq_group_setname': 'QQ设置昵称',
    'qq_group_wholeban': 'QQ全体禁言',
    'qq_message_send': 'QQ私聊回复',
    'qq_message_emojilike': 'QQ群贴表情',
    'qq_message_getfriendhistory': 'QQ获取私聊历史',
    'qq_message_getgrouphistory': 'QQ获取群历史',
    'qq_message_recall': 'QQ消息撤回',
    'qq_message_recentcontact': 'QQ最近联系人',
    'qq_system_getmodelshow': 'QQ获取设备标签',
    'qq_system_getuserstatus': 'QQ获取状态',
    'qq_system_setdiyonlinestatus': 'QQ设置自定义状态',
    'qq_system_setmodelshow': 'QQ设置设备标签',
    'qq_system_setonlinestatus': 'QQ设置状态',
    'qq_user_deletefriend': 'QQ删除好友',
    'qq_user_getprofilelike': 'QQ获取赞列表',
    'qq_user_sendlike': 'QQ点赞',
    'qq_user_sendpoke': 'QQ戳一戳',
    'realtime_search': '实时搜索',
    'suno_music_generate': 'Suno作曲',
    'system_info': '系统状态',
    'video_generate': '视频生成',
    'video_vision_read': '视频读取',
    'weather': '查询天气',
    'web_parser': '网页解析',
    'web_render_image': '前端渲染',
    'write_file': '文件写入'
  };
  return mapping[n] || name;
};

export const getIconForType = (name: string, type: 'module' | 'plugin'): React.ReactNode => {
  const n = name.toLowerCase();

  // Built-in apps
  if (n.includes('file-manager')) return <AppIconWrapper bg="linear-gradient(135deg, #f6d365 0%, #fda085 100%)"><IoFolderOpen color="white" /></AppIconWrapper>;
  if (n.includes('preset-importer')) return <AppIconWrapper bg="linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)"><IoCloudDownload color="white" /></AppIconWrapper>;
  if (n.includes('agent-presets') || n.includes('presets-editor')) return <AppIconWrapper bg="linear-gradient(135deg, #00b09b 0%, #96c93d 100%)"><IoDocumentText color="white" /></AppIconWrapper>;

  // Core Modules - Distinct colors for each
  if (n.includes('sentra-prompts')) return <AppIconWrapper bg="linear-gradient(135deg, #667eea 0%, #764ba2 100%)"><BsRobot color="white" /></AppIconWrapper>;
  if (n.includes('sentra-config-ui')) return <AppIconWrapper bg="linear-gradient(135deg, #434343 0%, #000000 100%)"><FcHome /></AppIconWrapper>;
  if (n.includes('sentra-mcp')) return <AppIconWrapper bg="linear-gradient(135deg, #11998e 0%, #38ef7d 100%)"><IoApps color="white" /></AppIconWrapper>;
  if (n.includes('sentra-emo')) return <AppIconWrapper bg="linear-gradient(135deg, #f093fb 0%, #f5576c 100%)"><FcStart /></AppIconWrapper>;
  if (n.includes('sentra-adapter')) return <AppIconWrapper bg="linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)"><FcSettings /></AppIconWrapper>;
  if (n.includes('sentra-rag')) return <AppIconWrapper bg="linear-gradient(135deg, #fa709a 0%, #fee140 100%)"><FcMindMap /></AppIconWrapper>;
  if (n.includes('dev-center')) return <AppIconWrapper bg="linear-gradient(135deg, #89f7fe 0%, #66a6ff 100%)"><IoApps color="white" /></AppIconWrapper>;
  if (n.includes('redis') || n.includes('agent-redis')) return <AppIconWrapper bg="linear-gradient(135deg, #ff512f 0%, #dd2476 100%)"><IoServer color="white" /></AppIconWrapper>;

  // Search & Web - Different shades of blue/green
  if (n.includes('bilibili')) return <AppIconWrapper bg="linear-gradient(135deg, #00c6ff 0%, #0072ff 100%)"><IoLogoYoutube color="white" /></AppIconWrapper>;
  if (n.includes('github')) return <AppIconWrapper bg="linear-gradient(135deg, #434343 0%, #000000 100%)"><IoLogoGithub color="white" /></AppIconWrapper>;
  if (n.includes('realtime_search')) return <AppIconWrapper bg="linear-gradient(135deg, #ffecd2 0%, #fcb69f 100%)"><FcSearch /></AppIconWrapper>;
  if (n.includes('image_search')) return <AppIconWrapper bg="linear-gradient(135deg, #a8edea 0%, #fed6e3 100%)"><FcSearch /></AppIconWrapper>;
  if (n.includes('web_parser')) return <AppIconWrapper bg="linear-gradient(135deg, #d299c2 0%, #fef9d7 100%)"><FcDocument /></AppIconWrapper>;
  if (n.includes('web_render')) return <AppIconWrapper bg="linear-gradient(135deg, #ffecd2 0%, #fcb69f 100%)"><FcGlobe /></AppIconWrapper>;
  if (n.includes('web')) return <AppIconWrapper bg="linear-gradient(135deg, #30cfd0 0%, #330867 100%)"><FcGlobe /></AppIconWrapper>;

  // Media - Each type gets unique gradient
  if (n.includes('emoji-stickers')) return <AppIconWrapper bg="linear-gradient(135deg, #ffeaa7 0%, #fdcb6e 100%)"><FcPicture /></AppIconWrapper>;
  if (n.includes('image_draw') || n.includes('image_vision_edit')) return <AppIconWrapper bg="linear-gradient(135deg, #a29bfe 0%, #6c5ce7 100%)"><FcPicture /></AppIconWrapper>;
  if (n.includes('image')) return <AppIconWrapper bg="linear-gradient(135deg, #fdcb6e 0%, #e17055 100%)"><FcImageFile /></AppIconWrapper>;
  if (n.includes('video')) return <AppIconWrapper bg="linear-gradient(135deg, #fd79a8 0%, #e84393 100%)"><FcVideoFile /></AppIconWrapper>;
  if (n.includes('suno')) return <AppIconWrapper bg="linear-gradient(135deg, #fa709a 0%, #fee140 100%)"><FcMusic /></AppIconWrapper>;
  if (n.includes('music')) return <AppIconWrapper bg="linear-gradient(135deg, #ff9ff3 0%, #feca57 100%)"><FcMusic /></AppIconWrapper>;
  if (n.includes('av_')) return <AppIconWrapper bg="linear-gradient(135deg, #48c6ef 0%, #6f86d6 100%)"><FcAudioFile /></AppIconWrapper>;

  // QQ plugins - Different colors for each category
  if (n.includes('qq_message_emojilike')) return <AppIconWrapper bg="linear-gradient(135deg, #ffeaa7 0%, #fdcb6e 100%)"><FcSms /></AppIconWrapper>;
  if (n.includes('qq_message')) return <AppIconWrapper bg="linear-gradient(135deg, #74b9ff 0%, #0984e3 100%)"><IoChatbubbles color="white" /></AppIconWrapper>;
  if (n.includes('qq_group_ban') || n.includes('qq_group_wholeban')) return <AppIconWrapper bg="linear-gradient(135deg, #fab1a0 0%, #e17055 100%)"><IoPeople color="white" /></AppIconWrapper>;
  if (n.includes('qq_group_kick') || n.includes('qq_group_leave')) return <AppIconWrapper bg="linear-gradient(135deg, #ff7675 0%, #d63031 100%)"><IoPeople color="white" /></AppIconWrapper>;
  if (n.includes('qq_group_info') || n.includes('qq_group_memberinfo') || n.includes('qq_group_memberlist')) return <AppIconWrapper bg="linear-gradient(135deg, #81ecec 0%, #00b894 100%)"><IoPeople color="white" /></AppIconWrapper>;
  if (n.includes('qq_group_list')) return <AppIconWrapper bg="linear-gradient(135deg, #a29bfe 0%, #6c5ce7 100%)"><IoPeople color="white" /></AppIconWrapper>;
  if (n.includes('qq_group')) return <AppIconWrapper bg="linear-gradient(135deg, #55efc4 0%, #00b894 100%)"><IoPeople color="white" /></AppIconWrapper>;
  if (n.includes('qq_account')) return <AppIconWrapper bg="linear-gradient(135deg, #ffeaa7 0%, #fdcb6e 100%)"><IoPerson color="white" /></AppIconWrapper>;
  if (n.includes('qq_avatar')) return <AppIconWrapper bg="linear-gradient(135deg, #74b9ff 0%, #0984e3 100%)"><FcContacts /></AppIconWrapper>;
  if (n.includes('qq_user_sendlike')) return <AppIconWrapper bg="linear-gradient(135deg, #ff7675 0%, #d63031 100%)"><IoPerson color="white" /></AppIconWrapper>;
  if (n.includes('qq_user_sendpoke')) return <AppIconWrapper bg="linear-gradient(135deg, #ffeaa7 0%, #fdcb6e 100%)"><IoPerson color="white" /></AppIconWrapper>;
  if (n.includes('qq_user_deletefriend')) return <AppIconWrapper bg="linear-gradient(135deg, #636e72 0%, #2d3436 100%)"><IoPerson color="white" /></AppIconWrapper>;
  if (n.includes('qq_user')) return <AppIconWrapper bg="linear-gradient(135deg, #a29bfe 0%, #6c5ce7 100%)"><IoPerson color="white" /></AppIconWrapper>;
  if (n.includes('qq_system_setonlinestatus') || n.includes('qq_system_setdiyonlinestatus')) return <AppIconWrapper bg="linear-gradient(135deg, #55efc4 0%, #00b894 100%)"><FcClock /></AppIconWrapper>;
  if (n.includes('qq_system')) return <AppIconWrapper bg="linear-gradient(135deg, #fab1a0 0%, #e17055 100%)"><FcAndroidOs /></AppIconWrapper>;

  // System & Tools - Distinct colors
  if (n.includes('mindmap')) return <AppIconWrapper bg="linear-gradient(135deg, #a8edea 0%, #fed6e3 100%)"><FcMindMap /></AppIconWrapper>;
  if (n.includes('document')) return <AppIconWrapper bg="linear-gradient(135deg, #e0c3fc 0%, #8ec5fc 100%)"><FcDocument /></AppIconWrapper>;
  if (n.includes('write_file')) return <AppIconWrapper bg="linear-gradient(135deg, #fbc2eb 0%, #a6c1ee 100%)"><FcDocument /></AppIconWrapper>;
  if (n.includes('weather')) return <AppIconWrapper bg="linear-gradient(135deg, #08aeea 0%, #2af598 100%)"><WiDaySunny color="white" /></AppIconWrapper>;
  if (n.includes('system_info')) return <AppIconWrapper bg="linear-gradient(135deg, #667eea 0%, #764ba2 100%)"><FcSettings /></AppIconWrapper>;
  if (n.includes('desktop')) return <AppIconWrapper bg="linear-gradient(135deg, #89f7fe 0%, #66a6ff 100%)"><FcHome /></AppIconWrapper>;
  if (n.includes('html_to_app')) return <AppIconWrapper bg="linear-gradient(135deg, #fa709a 0%, #fee140 100%)"><FcGlobe /></AppIconWrapper>;

  // Default
  if (type === 'module') return <AppIconWrapper bg="linear-gradient(135deg, #ff9a56 0%, #ff6a00 100%)"><FcFolder /></AppIconWrapper>;
  return <AppIconWrapper bg="linear-gradient(135deg, #29ffc6 0%, #20e3b2 100%)"><FcSettings /></AppIconWrapper>;
};