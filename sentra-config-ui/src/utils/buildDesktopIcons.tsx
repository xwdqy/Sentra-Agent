import type { DesktopIcon, AppFolder } from '../types/ui';
import { AppIconWrapper, getIconForType } from './icons';
import {
    IoConstruct,
    IoPlayCircle,
    IoCloudDownload,
    IoRefreshCircle,
    IoSettings,
    IoPlay,
    IoHappy,
} from 'react-icons/io5';

// Helper to create folder icon with app thumbnails
function createFolderIcon(apps: DesktopIcon[], bgColor: string) {
    return (
        <div style={{
            width: 60,
            height: 60,
            borderRadius: '14px',
            background: `linear-gradient(135deg, ${bgColor}20 0%, ${bgColor}40 100%)`,
            backdropFilter: 'blur(10px)',
            border: `2px solid ${bgColor}60`,
            padding: 6,
            display: 'grid',
            gridTemplateColumns: 'repeat(2, 1fr)',
            gridTemplateRows: 'repeat(2, 1fr)',
            gap: 4,
            boxShadow: `0 8px 24px ${bgColor}40, inset 0 1px 2px rgba(255,255,255,0.3)`,
        }}>
            {apps.slice(0, 4).map((app, index) => (
                <div
                    key={index}
                    style={{
                        width: '100%',
                        height: '100%',
                        borderRadius: '6px',
                        overflow: 'hidden',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: 'rgba(255, 255, 255, 0.1)',
                    }}
                >
                    <div style={{ transform: 'scale(0.4)', transformOrigin: 'center' }}>
                        {app.icon}
                    </div>
                </div>
            ))}
        </div>
    );
}

export function buildDesktopFolders(
    recordUsage: (key: string) => void,
    handleRunBootstrap: () => void,
    handleRunStart: () => void,
    handleRunNapcatBuild: () => void,
    handleRunNapcatStart: () => void,
    handleRunUpdate: () => void,
    handleRunForceUpdate: () => void,
    handleRunSentiment: () => void,
): AppFolder[] {
    const iconSize = 56;
    const gap = 120;
    const startX = 30;
    const startY = 80;

    // Build individual app icons  
    const bootstrapApp: DesktopIcon = {
        id: 'desktop-bootstrap',
        name: '安装依赖',
        icon: <AppIconWrapper
            bg="linear-gradient(135deg, #667eea 0%, #764ba2 100%)"
            shadow="0 8px 16px rgba(102, 126, 234, 0.4), inset 0 1px 2px rgba(255,255,255,0.3)"
        >
            <IoConstruct color="white" size={iconSize} />
        </AppIconWrapper>,
        position: { x: 0, y: 0 },
        onClick: () => {
            recordUsage('script:bootstrap');
            handleRunBootstrap();
        }
    };

    const napcatBuildApp: DesktopIcon = {
        id: 'desktop-napcat-build',
        name: '构建NC SDK',
        icon: <AppIconWrapper
            bg="linear-gradient(135deg, #ffa726 0%, #f57c00 100%)"
            shadow="0 8px 16px rgba(255, 167, 38, 0.4), inset 0 1px 2px rgba(255,255,255,0.3)"
        >
            <IoSettings color="white" size={iconSize} />
        </AppIconWrapper>,
        position: { x: 0, y: 0 },
        onClick: () => {
            recordUsage('script:napcat-build');
            handleRunNapcatBuild();
        }
    };

    const startApp: DesktopIcon = {
        id: 'desktop-start',
        name: '启动Sentra',
        icon: <AppIconWrapper
            bg="linear-gradient(135deg, #42a5f5 0%, #1976d2 100%)"
            shadow="0 8px 16px rgba(66, 165, 245, 0.4), inset 0 1px 2px rgba(255,255,255,0.3)"
        >
            <IoPlayCircle color="white" size={iconSize} />
        </AppIconWrapper>,
        position: { x: 0, y: 0 },
        onClick: () => {
            recordUsage('script:start');
            handleRunStart();
        }
    };

    const sentimentApp: DesktopIcon = {
        id: 'desktop-sentiment',
        name: '情感分析',
        icon: <AppIconWrapper
            bg="linear-gradient(135deg, #ff9a9e 0%, #fecfef 99%, #fecfef 100%)"
            shadow="0 8px 16px rgba(255, 154, 158, 0.4), inset 0 1px 2px rgba(255,255,255,0.3)"
        >
            <IoHappy color="white" size={iconSize} />
        </AppIconWrapper>,
        position: { x: 0, y: 0 },
        onClick: () => {
            recordUsage('script:sentiment');
            handleRunSentiment();
        }
    };

    const napcatStartApp: DesktopIcon = {
        id: 'desktop-napcat-start',
        name: '启动NC流服务',
        icon: <AppIconWrapper
            bg="linear-gradient(135deg, #ab47bc 0%, #7b1fa2 100%)"
            shadow="0 8px 16px rgba(171, 71, 188, 0.4), inset 0 1px 2px rgba(255,255,255,0.3)"
        >
            <IoPlay color="white" size={iconSize} />
        </AppIconWrapper>,
        position: { x: 0, y: 0 },
        onClick: () => {
            recordUsage('script:napcat-start');
            handleRunNapcatStart();
        }
    };

    const updateApp: DesktopIcon = {
        id: 'desktop-update',
        name: '更新',
        icon: <AppIconWrapper
            bg="linear-gradient(135deg, #66bb6a 0%, #43a047 100%)"
            shadow="0 8px 16px rgba(102, 187, 106, 0.4), inset 0 1px 2px rgba(255,255,255,0.3)"
        >
            <IoCloudDownload color="white" size={iconSize} />
        </AppIconWrapper>,
        position: { x: 0, y: 0 },
        onClick: () => {
            recordUsage('script:update');
            handleRunUpdate();
        }
    };

    const forceUpdateApp: DesktopIcon = {
        id: 'desktop-force-update',
        name: '强制更新',
        icon: <AppIconWrapper
            bg="linear-gradient(135deg, #ef5350 0%, #c62828 100%)"
            shadow="0 8px 16px rgba(239, 83, 80, 0.4), inset 0 1px 2px rgba(255,255,255,0.3)"
        >
            <IoRefreshCircle color="white" size={iconSize} />
        </AppIconWrapper>,
        position: { x: 0, y: 0 },
        onClick: () => {
            recordUsage('script:force-update');
            handleRunForceUpdate();
        }
    };

    const buildApps = [bootstrapApp, napcatBuildApp];
    const startApps = [startApp, napcatStartApp, sentimentApp];
    const updateApps = [updateApp, forceUpdateApp];

    // Create folders with thumbnail previews
    return [
        {
            id: 'folder-build',
            name: '构建工具',
            icon: createFolderIcon(buildApps, '#667eea'),
            position: { x: startX, y: startY },
            apps: buildApps
        },
        {
            id: 'folder-start',
            name: '启动服务',
            icon: createFolderIcon(startApps, '#42a5f5'),
            position: { x: startX + gap, y: startY },
            apps: startApps
        },
        {
            id: 'folder-update',
            name: '系统更新',
            icon: createFolderIcon(updateApps, '#66bb6a'),
            position: { x: startX + gap * 2, y: startY },
            apps: updateApps
        }
    ];
}

export function buildDesktopIcons(
    recordUsage: (key: string) => void,
    handleRunBootstrap: () => void,
    handleRunStart: () => void,
    handleRunNapcatBuild: () => void,
    handleRunNapcatStart: () => void,
    handleRunUpdate: () => void,
    handleRunForceUpdate: () => void,
    handleRunSentiment: () => void,
    handleOpenPresets: () => void,
    handleOpenFileManager: () => void,
    handleOpenDevCenter: () => void,
    handleOpenPresetImporter: () => void,
    handleOpenRedisAdmin?: () => void,
): DesktopIcon[] {
    const iconSize = 56;
    const gap = 100;
    const startX = 30;
    const startY = 80;

    return [
        {
            id: 'desktop-redis-admin',
            name: 'Redis 管理器',
            icon: getIconForType('redis-admin', 'module'),
            position: { x: startX + gap * 4, y: startY },
            onClick: () => {
                recordUsage('app:redis-admin');
                if (handleOpenRedisAdmin) handleOpenRedisAdmin();
                else handleOpenDevCenter();
            }
        },
        {
            id: 'desktop-filemanager',
            name: '文件管理',
            icon: getIconForType('file-manager', 'module'),
            position: { x: startX, y: startY },
            onClick: () => {
                recordUsage('app:filemanager');
                handleOpenFileManager();
            }
        },
        {
            id: 'desktop-preset-importer',
            name: '预设导入',
            icon: getIconForType('preset-importer', 'module'),
            position: { x: startX + gap, y: startY },
            onClick: () => {
                recordUsage('app:preset-importer');
                handleOpenPresetImporter();
            }
        },
        {
            id: 'desktop-dev-center',
            name: '开发中心',
            icon: getIconForType('dev-center', 'module'),
            position: { x: startX + gap * 3, y: startY },
            onClick: () => {
                recordUsage('app:dev-center');
                handleOpenDevCenter();
            }
        },
        {
            id: 'desktop-presets',
            name: '预设撰写',
            icon: getIconForType('presets-editor', 'module'),
            position: { x: startX + gap * 2, y: startY },
            onClick: () => {
                recordUsage('app:presets');
                handleOpenPresets();
            }
        },
        {
            id: 'desktop-bootstrap',
            name: '安装依赖',
            icon: <AppIconWrapper
                bg="linear-gradient(135deg, #667eea 0%, #764ba2 100%)"
                shadow="0 8px 16px rgba(102, 126, 234, 0.4), inset 0 1px 2px rgba(255,255,255,0.3)"
            >
                <IoConstruct color="white" size={iconSize} />
            </AppIconWrapper>,
            position: { x: startX, y: startY + gap },
            onClick: () => {
                recordUsage('script:bootstrap');
                handleRunBootstrap();
            }
        },
        {
            id: 'desktop-start',
            name: '启动Sentra',
            icon: <AppIconWrapper
                bg="linear-gradient(135deg, #42a5f5 0%, #1976d2 100%)"
                shadow="0 8px 16px rgba(66, 165, 245, 0.4), inset 0 1px 2px rgba(255,255,255,0.3)"
            >
                <IoPlayCircle color="white" size={iconSize} />
            </AppIconWrapper>,
            position: { x: startX + gap, y: startY + gap },
            onClick: () => {
                recordUsage('script:start');
                handleRunStart();
            }
        },
        {
            id: 'desktop-update',
            name: '更新',
            icon: <AppIconWrapper
                bg="linear-gradient(135deg, #66bb6a 0%, #43a047 100%)"
                shadow="0 8px 16px rgba(102, 187, 106, 0.4), inset 0 1px 2px rgba(255,255,255,0.3)"
            >
                <IoCloudDownload color="white" size={iconSize} />
            </AppIconWrapper>,
            position: { x: startX + gap * 2, y: startY + gap },
            onClick: () => {
                recordUsage('script:update');
                handleRunUpdate();
            }
        },
        {
            id: 'desktop-force-update',
            name: '强制更新',
            icon: <AppIconWrapper
                bg="linear-gradient(135deg, #ef5350 0%, #c62828 100%)"
                shadow="0 8px 16px rgba(239, 83, 80, 0.4), inset 0 1px 2px rgba(255,255,255,0.3)"
            >
                <IoRefreshCircle color="white" size={iconSize} />
            </AppIconWrapper>,
            position: { x: startX + gap * 3, y: startY + gap },
            onClick: () => {
                recordUsage('script:force-update');
                handleRunForceUpdate();
            }
        },
        {
            id: 'desktop-sentiment',
            name: '情感分析',
            icon: <AppIconWrapper
                bg="linear-gradient(135deg, #ff9a9e 0%, #fecfef 99%, #fecfef 100%)"
                shadow="0 8px 16px rgba(255, 154, 158, 0.4), inset 0 1px 2px rgba(255,255,255,0.3)"
            >
                <IoHappy color="white" size={iconSize} />
            </AppIconWrapper>,
            position: { x: startX + gap * 4, y: startY + gap },
            onClick: () => {
                recordUsage('script:sentiment');
                handleRunSentiment();
            }
        },
        {
            id: 'desktop-napcat-build',
            name: '构建NC SDK',
            icon: <AppIconWrapper
                bg="linear-gradient(135deg, #ffa726 0%, #f57c00 100%)"
                shadow="0 8px 16px rgba(255, 167, 38, 0.4), inset 0 1px 2px rgba(255,255,255,0.3)"
            >
                <IoSettings color="white" size={iconSize} />
            </AppIconWrapper>,
            position: { x: startX, y: startY + gap },
            onClick: () => {
                recordUsage('script:napcat-build');
                handleRunNapcatBuild();
            }
        },
        {
            id: 'desktop-napcat-start',
            name: '启动NC流服务',
            icon: <AppIconWrapper
                bg="linear-gradient(135deg, #ab47bc 0%, #7b1fa2 100%)"
                shadow="0 8px 16px rgba(171, 71, 188, 0.4), inset 0 1px 2px rgba(255,255,255,0.3)"
            >
                <IoPlay color="white" size={iconSize} />
            </AppIconWrapper>,
            position: { x: startX + gap, y: startY + gap },
            onClick: () => {
                recordUsage('script:napcat-start');
                handleRunNapcatStart();
            }
        }
    ];
}
