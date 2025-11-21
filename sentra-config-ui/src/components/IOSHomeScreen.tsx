import React from 'react';
import { IoWifi, IoBatteryFull, IoApps } from 'react-icons/io5';
import { DesktopIcon } from '../App';

interface IOSHomeScreenProps {
    icons: DesktopIcon[];
    onLaunch: (icon: DesktopIcon) => void;
    wallpaper: string;
    onLaunchpadOpen: () => void;
    dockExtra: { id: string; icon: React.ReactNode; onClick: () => void }[];
}

export const IOSHomeScreen: React.FC<IOSHomeScreenProps> = ({ icons, onLaunch, wallpaper, onLaunchpadOpen, dockExtra }) => {
    // Use real icons for the grid (limit to 12 to prevent overflow)
    const gridIcons = icons.slice(0, 12);

    // Dock: Launchpad + dynamic top-used apps from props
    const dockIcons = [
        {
            id: 'launchpad',
            name: '启动台',
            icon: <div style={{
                width: 54,
                height: 54,
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
        ...dockExtra
    ];

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
                {gridIcons.map(icon => (
                    <div key={icon.id} className="ios-icon-container" onClick={() => onLaunch(icon)}>
                        <div className="ios-icon" style={{ background: 'rgba(255,255,255,0.2)', backdropFilter: 'blur(10px)' }}>
                            {icon.icon}
                        </div>
                        <div className="ios-label">{icon.name}</div>
                    </div>
                ))}
            </div>

            {/* Dock */}
            <div className="ios-dock">
                {dockIcons.map(icon => (
                    <div key={icon.id} className="ios-icon-container" onClick={icon.onClick} style={{ marginBottom: 0 }}>
                        <div className="ios-icon" style={{ background: 'rgba(255,255,255,0.2)', backdropFilter: 'blur(10px)' }}>
                            {icon.icon}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};
