import type { ReactNode } from 'react';
import type { DesktopIcon, AppFolder } from '../../types/ui';

type AnchorRect = { left: number; top: number; width: number; height: number };

type DesktopIconsLayerProps = {
  desktopIcons?: DesktopIcon[];
  desktopFolders?: AppFolder[];
  renderTopTile: (key: string, label: string, icon: ReactNode, onClick: (e: React.MouseEvent) => void) => ReactNode;
  onOpenFolder: (id: string, anchorRect: AnchorRect) => void;
};

export function DesktopIconsLayer(props: DesktopIconsLayerProps) {
  const { desktopIcons, desktopFolders, renderTopTile, onOpenFolder } = props;

  if (desktopFolders) {
    return (
      <>
        <div
          style={{
            position: 'absolute',
            left: 30,
            top: 80,
            display: 'flex',
            gap: 32,
          }}
        >
          {desktopFolders.map(folder => (
            renderTopTile(folder.id, folder.name, folder.icon, (e) => {
              e.stopPropagation();
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              onOpenFolder(folder.id, { left: rect.left, top: rect.top, width: rect.width, height: rect.height });
            })
          ))}

          {desktopIcons?.find(i => i.id === 'desktop-filemanager') && (() => {
            const icon = desktopIcons.find(i => i.id === 'desktop-filemanager')!;
            return renderTopTile(icon.id, icon.name, icon.icon, (e) => {
              e.stopPropagation();
              icon.onClick();
            });
          })()}

          {desktopIcons?.find(i => i.id === 'desktop-preset-importer') && (() => {
            const icon = desktopIcons.find(i => i.id === 'desktop-preset-importer')!;
            return renderTopTile(icon.id, icon.name, icon.icon, (e) => {
              e.stopPropagation();
              icon.onClick();
            });
          })()}

          {desktopIcons?.find(i => i.id === 'desktop-dev-center') && (() => {
            const icon = desktopIcons.find(i => i.id === 'desktop-dev-center')!;
            return renderTopTile(icon.id, icon.name, icon.icon, (e) => {
              e.stopPropagation();
              icon.onClick();
            });
          })()}

          {desktopIcons?.find(i => i.id === 'desktop-redis-admin') && (() => {
            const icon = desktopIcons.find(i => i.id === 'desktop-redis-admin')!;
            return renderTopTile(icon.id, icon.name, icon.icon, (e) => {
              e.stopPropagation();
              icon.onClick();
            });
          })()}

          {desktopIcons?.find(i => i.id === 'desktop-model-providers-manager') && (() => {
            const icon = desktopIcons.find(i => i.id === 'desktop-model-providers-manager')!;
            return renderTopTile(icon.id, icon.name, icon.icon, (e) => {
              e.stopPropagation();
              icon.onClick();
            });
          })()}

          {desktopIcons?.find(i => i.id === 'desktop-presets') && (() => {
            const icon = desktopIcons.find(i => i.id === 'desktop-presets')!;
            return renderTopTile(icon.id, icon.name, icon.icon, (e) => {
              e.stopPropagation();
              icon.onClick();
            });
          })()}
        </div>
      </>
    );
  }

  if (!desktopIcons) return null;

  return (
    <>
      {desktopIcons.map(icon => (
        <div
          key={icon.id}
          style={{
            position: 'absolute',
            left: icon.position.x,
            top: icon.position.y,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            cursor: 'pointer',
            padding: '8px',
            borderRadius: '8px',
            transition: 'background 0.2s',
            width: 80,
          }}
          onClick={icon.onClick}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          <div style={{ marginBottom: 4 }}>{icon.icon}</div>
          <div style={{
            fontSize: 12,
            color: 'white',
            textShadow: '0 1px 3px rgba(0,0,0,0.8)',
            fontWeight: 500,
            textAlign: 'center',
            lineHeight: 1.2,
          }}>
            {icon.name}
          </div>
        </div>
      ))}
    </>
  );
}
