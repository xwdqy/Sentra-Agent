import { Button, Drawer, Form, InputNumber, Space, Tooltip } from 'antd';
import styles from './QqSandbox.module.css';

export function SettingsDrawer(props: {
  showDev: boolean;
  setShowDev: (v: boolean) => void;
  napcatEnvPath: string;
  streamPort: number;
  defaultStreamPort: number;
  setStreamPort: (v: number) => void;
  napcatBusy: boolean;
  onStartNapcat: () => void;
  onStopNapcat: () => void;
  onUseDefaultPort: () => void;
  onClearPortOverride: () => void;
}) {
  const {
    showDev,
    setShowDev,
    napcatEnvPath,
    streamPort,
    defaultStreamPort,
    setStreamPort,
    napcatBusy,
    onStartNapcat,
    onStopNapcat,
    onUseDefaultPort,
    onClearPortOverride,
  } = props;

  return (
    <Drawer
      title="QQ 沙盒设置"
      open={showDev}
      onClose={() => setShowDev(false)}
      size="default"
      styles={{ body: { paddingTop: 12 }, section: { width: 420 } }}
    >
      <div className={styles.devPanel}>
        <Form
          className={styles.settingsForm}
          layout="horizontal"
          size="small"
          labelCol={{ flex: '86px' }}
          wrapperCol={{ flex: 'auto' }}
        >
          <Form.Item
            label="Stream 端口"
            extra={napcatEnvPath ? `Napcat 配置路径：${napcatEnvPath}` : '正在读取 Napcat 配置...'}
          >
            <InputNumber
              className={styles.portInput}
              min={1}
              max={65535}
              value={Number.isFinite(streamPort) && streamPort > 0 ? streamPort : null}
              placeholder={defaultStreamPort > 0 ? String(defaultStreamPort) : 'STREAM_PORT'}
              onChange={(v) => {
                const n = typeof v === 'number' ? v : Number(v);
                setStreamPort(Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0);
              }}
            />
          </Form.Item>

          <Form.Item label="Napcat" >
            <Space size={8} wrap={false} className={styles.settingsActions}>
              <Tooltip title="启动 Napcat">
                <Button className={styles.smallBtn} disabled={napcatBusy} onClick={onStartNapcat}>
                  启动
                </Button>
              </Tooltip>
              <Tooltip title="停止 Napcat">
                <Button className={styles.smallBtn} disabled={napcatBusy} onClick={onStopNapcat}>
                  停止
                </Button>
              </Tooltip>
            </Space>
          </Form.Item>

          <Form.Item label="端口操作">
            <Space size={8} wrap={false} className={styles.settingsActions}>
              <Tooltip title={defaultStreamPort > 0 ? `恢复默认端口：${defaultStreamPort}` : '暂无默认端口'}>
                <Button className={styles.smallBtn} onClick={onUseDefaultPort} disabled={defaultStreamPort <= 0}>
                  使用默认
                </Button>
              </Tooltip>
              <Tooltip title="删除本地保存的端口覆盖（将回到默认端口）">
                <Button className={styles.smallBtn} onClick={onClearPortOverride}>
                  清除覆盖
                </Button>
              </Tooltip>
            </Space>
          </Form.Item>
        </Form>
      </div>
    </Drawer>
  );
}
