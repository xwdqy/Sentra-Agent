import React from 'react';
import { IoWifi, IoBatteryFull, IoApps } from 'react-icons/io5';
import { DesktopIcon, AppFolder } from '../types/ui';
import { IOSAppFolder } from './IOSAppFolder';

interface IOSHomeScreenProps {
    icons: DesktopIcon[];
    folders: AppFolder[];
    onLaunch: (icon: DesktopIcon) => void;
    wallpaper: string;
    onLaunchpadOpen: () => void;
    dockExtra: { id: string; name: string; icon: React.ReactNode; onClick: () => void }[];
}

export const IOSHomeScreen: React.FC<IOSHomeScreenProps> = ({ icons, folders, onLaunch, wallpaper, onLaunchpadOpen, dockExtra }) => {
    // Combine folders and icons, folders first
    const allItems = [...folders, ...icons];
    // Use real icons for the grid (limit to 24 to prevent overflow)
    const gridItems = allItems.slice(0, 24);

    const computeDockCapacity = React.useCallback(() => {
        const w = window.innerWidth || 390;
        const dockIconSize = Math.min(54, Math.max(44, Math.round(w * 0.12)));
        const leftRight = 40; // ios.css: left/right = 20px
        const padding = 24; // ios.css: padding = 0 12px
        const gap = 10; // ios.css: gap = 10px
        const available = Math.max(0, w - leftRight - padding);
        const cap = Math.floor((available + gap) / (dockIconSize + gap));
        return Math.max(3, Math.min(8, cap));
    }, []);

    const [dockCapacity, setDockCapacity] = React.useState<number>(() => {
        if (typeof window === 'undefined') return 5;
        return computeDockCapacity();
    });

    React.useEffect(() => {
        const onResize = () => setDockCapacity(computeDockCapacity());
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, [computeDockCapacity]);

    const [openFolderId, setOpenFolderId] = React.useState<string | null>(null);

    // Dock: Launchpad + dynamic top-used apps from props
    const uniqueDockExtra = React.useMemo(() => {
        const out: { id: string; name: string; icon: React.ReactNode; onClick: () => void }[] = [];
        const seen = new Set<string>();
        for (const it of dockExtra || []) {
            if (!it || !it.id) continue;
            if (seen.has(it.id)) continue;
            seen.add(it.id);
            out.push(it);
        }
        return out;
    }, [dockExtra]);

    const dockIcons = [
        {
            id: 'launchpad',
            name: '启动台',
            icon: <div style={{
                width: 'var(--ios-dock-icon-size)',
                height: 'var(--ios-dock-icon-size)',
                background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                borderRadius: 12,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 4px 12px rgba(102, 126, 234, 0.3)'
            }}>
                <IoApps size={28} color="white" />
            </div>,
            onClick: onLaunchpadOpen
        },
        ...uniqueDockExtra.slice(0, Math.max(0, dockCapacity - 1))
    ];

    // Long-press to show name on Dock icons
    const [showId, setShowId] = React.useState<string | null>(null);
    const timerRef = React.useRef<number | null>(null);
    const clearTimer = () => { if (timerRef.current) { window.clearTimeout(timerRef.current); timerRef.current = null; } };
    const bindLong = (id: string) => ({
        onMouseDown: () => { clearTimer(); timerRef.current = window.setTimeout(() => setShowId(id), 500); },
        onMouseUp: () => { clearTimer(); setShowId(null); },
        onMouseLeave: () => { clearTimer(); setShowId(null); },
        onTouchStart: () => { clearTimer(); timerRef.current = window.setTimeout(() => setShowId(id), 500); },
        onTouchEnd: () => { clearTimer(); setShowId(null); },
        onTouchCancel: () => { clearTimer(); setShowId(null); },
        onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    });

    return (
        <div className="ios-container" style={{ backgroundImage: `url(${wallpaper})`, backgroundSize: 'cover', backgroundPosition: 'center', backgroundRepeat: 'no-repeat' }}>
            {/* Status Bar */}
            <div className="ios-status-bar">
                <div>{new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: false })}</div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <IoWifi size={18} />
                    <IoBatteryFull size={20} />
                </div>
            </div>

            {/* Grid Area */}
            <div className="ios-grid">
                {gridItems.map(item => {
                    if ('apps' in item) {
                        // It's a folder
                        return (
                            <div key={item.id} className="ios-icon-container">
                                <IOSAppFolder
                                    folder={item}
                                    isOpen={openFolderId === item.id}
                                    onOpen={() => setOpenFolderId(item.id)}
                                    onClose={() => setOpenFolderId(null)}
                                    onAppClick={(_appId, onClick) => {
                                        onClick();
                                        setOpenFolderId(null);
                                    }}
                                />
                            </div>
                        );
                    } else {
                        // It's an icon
                        return (
                            <div key={item.id} className="ios-icon-container" onClick={() => onLaunch(item)}>
                                <div className="ios-icon" style={{ background: 'rgba(255,255,255,0.2)', backdropFilter: 'blur(10px)' }}>
                                    {item.icon}
                                </div>
                                <div className="ios-label">{item.name}</div>
                            </div>
                        );
                    }
                })}
            </div>

            {/* Dock */}
            <div className="ios-dock">
                {dockIcons.map(icon => (
                    <div
                        key={icon.id}
                        className="ios-icon-container"
                        onClick={icon.onClick}
                        style={{ marginBottom: 0, position: 'relative' }}
                        {...bindLong(icon.id)}
                    >
                        <div className="ios-icon" style={{ background: 'rgba(255,255,255,0.2)', backdropFilter: 'blur(10px)' }}>
                            {icon.icon}
                        </div>
                        {showId === icon.id && (
                            <div style={{
                                position: 'absolute',
                                bottom: 'calc(var(--ios-dock-icon-size) + 10px)',
                                left: '50%',
                                transform: 'translateX(-50%)',
                                background: 'rgba(0,0,0,0.8)',
                                color: '#fff',
                                padding: '4px 8px',
                                borderRadius: 6,
                                fontSize: 12,
                                whiteSpace: 'nowrap',
                                pointerEvents: 'none'
                            }}>
                                {icon.name}
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
};
