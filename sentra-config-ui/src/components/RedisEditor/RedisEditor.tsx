import React, { useState, useEffect, useMemo, useCallback } from 'react';
import styles from './RedisEditor.module.css';
import { Button, Input, Segmented, Space } from 'antd';
import { CloudServerOutlined, DeleteOutlined, LinkOutlined, ReloadOutlined } from '@ant-design/icons';
import { useRedisEditor } from '../../hooks/useRedisEditor';
import Editor from '@monaco-editor/react';
import '../../utils/monacoSetup';

interface RedisEditorProps {
    theme: 'light' | 'dark';
    state: ReturnType<typeof useRedisEditor>;
}

export const RedisEditor: React.FC<RedisEditorProps> = React.memo(({ theme, state }) => {
    const [host, setHost] = useState('127.0.0.1');
    const [port, setPort] = useState('6379');
    const [password, setPassword] = useState('');
    const [name, setName] = useState('Local Redis');
    const [activeTab, setActiveTab] = useState<'keys' | 'terminal'>('keys');

    // Terminal state
    const [command, setCommand] = useState('');
    const [history, setHistory] = useState<{ type: 'in' | 'out' | 'err', text: string }[]>([]);

    // Keys state
    const [keys, setKeys] = useState<string[]>([]);
    const [selectedKey, setSelectedKey] = useState<string | null>(null);
    const [keyValue, setKeyValue] = useState<any>(null);
    const [keyType, setKeyType] = useState<string>('');
    const [filter, setFilter] = useState('*');
    const [editMode, setEditMode] = useState(false);
    const [editedValue, setEditedValue] = useState<string>('');

    const { connect, disconnect, executeCommand, activeConnectionId, connections, setActiveConnectionId } = state;

    useEffect(() => {
        state.fetchConnections();
    }, []);

    useEffect(() => {
        if (activeConnectionId) {
            refreshKeys();
        } else {
            setKeys([]);
            setHistory([]);
        }
    }, [activeConnectionId]);

    const handleConnect = async () => {
        await connect(name, host, parseInt(port), password || undefined);
    };

    const refreshKeys = useCallback(async () => {
        if (!activeConnectionId) return;
        const res = await executeCommand(activeConnectionId, 'KEYS', [filter]);
        if (res.success && Array.isArray(res.result)) {
            setKeys(res.result.sort());
        }
    }, [activeConnectionId, filter, executeCommand]);

    const handleKeySelect = async (key: string) => {
        if (!activeConnectionId) return;
        setSelectedKey(key);
        setEditMode(false);

        // Get Type
        const typeRes = await executeCommand(activeConnectionId, 'TYPE', [key]);
        if (typeRes.success) setKeyType(typeRes.result);

        // Get Value
        let valRes;
        if (typeRes.result === 'string') {
            valRes = await executeCommand(activeConnectionId, 'GET', [key]);
        } else if (typeRes.result === 'hash') {
            valRes = await executeCommand(activeConnectionId, 'HGETALL', [key]);
        } else if (typeRes.result === 'list') {
            valRes = await executeCommand(activeConnectionId, 'LRANGE', [key, '0', '-1']);
        } else if (typeRes.result === 'set') {
            valRes = await executeCommand(activeConnectionId, 'SMEMBERS', [key]);
        } else if (typeRes.result === 'zset') {
            valRes = await executeCommand(activeConnectionId, 'ZRANGE', [key, '0', '-1', 'WITHSCORES']);
        } else {
            valRes = { success: true, result: '(Unsupported type)' };
        }

        if (valRes.success) {
            setKeyValue(valRes.result);
            setEditedValue(typeof valRes.result === 'object' ? JSON.stringify(valRes.result, null, 2) : String(valRes.result));
        }
    };

    const isJSON = (str: string) => {
        try {
            JSON.parse(str);
            return true;
        } catch {
            return false;
        }
    };

    const handleSaveValue = useCallback(async () => {
        if (!activeConnectionId || !selectedKey) return;

        try {
            if (keyType === 'string') {
                await executeCommand(activeConnectionId, 'SET', [selectedKey, editedValue]);
            } else if (keyType === 'hash') {
                const parsed = JSON.parse(editedValue);
                const args = Object.entries(parsed).flat() as string[];
                await executeCommand(activeConnectionId, 'HMSET', [selectedKey, ...args]);
            }
            setEditMode(false);
            handleKeySelect(selectedKey); // Refresh
        } catch (err) {
            console.error('Save failed', err);
        }
    }, [activeConnectionId, selectedKey, keyType, editedValue, executeCommand, handleKeySelect]);

    const handleDeleteKey = useCallback(async () => {
        if (!activeConnectionId || !selectedKey) return;
        await executeCommand(activeConnectionId, 'DEL', [selectedKey]);
        setSelectedKey(null);
        setKeyValue(null);
        refreshKeys();
    }, [activeConnectionId, selectedKey, executeCommand, refreshKeys]);

    const runCommand = async () => {
        if (!activeConnectionId || !command.trim()) return;

        const parts = command.trim().split(/\s+/);
        const cmd = parts[0];
        const args = parts.slice(1);

        setHistory(prev => [...prev, { type: 'in', text: command }]);
        setCommand('');

        const res = await executeCommand(activeConnectionId, cmd, args);
        if (res.success) {
            const output = typeof res.result === 'object' ? JSON.stringify(res.result, null, 2) : String(res.result);
            setHistory(prev => [...prev, { type: 'out', text: output }]);
        } else {
            setHistory(prev => [...prev, { type: 'err', text: res.error }]);
        }
    };

    const renderValue = useMemo(() => {
        if (!keyValue) return null;

        // 编辑模式：直接用 Monaco 编辑器
        if (editMode && (keyType === 'string' || keyType === 'hash')) {
            return (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                    <Editor
                        height="100%"
                        language={keyType === 'string' && isJSON(editedValue) ? 'json' : 'plaintext'}
                        value={editedValue}
                        onChange={(val) => setEditedValue(val || '')}
                        theme={theme === 'dark' ? 'vs-dark' : 'light'}
                        options={{
                            minimap: { enabled: false },
                            fontSize: 13,
                            wordWrap: 'on',
                            find: {
                                addExtraSpaceOnTop: true,
                            },
                        }}
                    />
                    <div style={{ padding: '10px 0', display: 'flex', gap: 8 }}>
                        <Button size="small" type="primary" onClick={handleSaveValue}>保存</Button>
                        <Button size="small" onClick={() => setEditMode(false)}>取消</Button>
                    </div>
                </div>
            );
        }

        // 不同类型的只读预览
        if (keyType === 'hash' && typeof keyValue === 'object') {
            return (
                <div className={styles.hashView}>
                    <table className={styles.hashTable}>
                        <thead>
                            <tr>
                                <th>Field</th>
                                <th>Value</th>
                            </tr>
                        </thead>
                        <tbody>
                            {Object.entries(keyValue).map(([field, value]) => (
                                <tr key={field}>
                                    <td className={styles.fieldName}>{field}</td>
                                    <td className={styles.fieldValue}>{String(value)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            );
        }

        if ((keyType === 'list' || keyType === 'set') && Array.isArray(keyValue)) {
            return (
                <div className={styles.listView}>
                    {keyValue.map((item, idx) => (
                        <div key={idx} className={styles.listItem}>
                            <span className={styles.listIndex}>{idx}</span>
                            <span className={styles.listValue}>{String(item)}</span>
                        </div>
                    ))}
                </div>
            );
        }

        if (keyType === 'zset' && Array.isArray(keyValue)) {
            return (
                <div className={styles.zsetView}>
                    <table className={styles.hashTable}>
                        <thead>
                            <tr>
                                <th>Member</th>
                                <th>Score</th>
                            </tr>
                        </thead>
                        <tbody>
                            {keyValue.reduce((acc: any[], item: any, idx: number) => {
                                if (idx % 2 === 0) {
                                    acc.push({ member: item, score: keyValue[idx + 1] });
                                }
                                return acc;
                            }, []).map((row: any, idx: number) => (
                                <tr key={idx}>
                                    <td className={styles.fieldValue}>{row.member}</td>
                                    <td className={styles.fieldName}>{row.score}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            );
        }

        // String：优先按 JSON 高亮展示
        if (keyType === 'string') {
            const strValue = String(keyValue);
            if (isJSON(strValue)) {
                try {
                    const parsed = JSON.parse(strValue);
                    return (
                        <div className={styles.jsonView}>
                            <Editor
                                height="400px"
                                language="json"
                                value={JSON.stringify(parsed, null, 2)}
                                theme={theme === 'dark' ? 'vs-dark' : 'light'}
                                options={{
                                    readOnly: true,
                                    minimap: { enabled: false },
                                    fontSize: 13,
                                    wordWrap: 'on',
                                    find: {
                                        addExtraSpaceOnTop: true,
                                    },
                                }}
                            />
                        </div>
                    );
                } catch {
                    // fall through to plain textarea
                }
            }
            return <Input.TextArea value={strValue} readOnly className={styles.valueContent} autoSize={{ minRows: 6, maxRows: 16 }} />;
        }

        return <div className={styles.emptyState}>不支持的数据类型</div>;
    }, [keyValue, keyType, editMode, editedValue, theme, handleSaveValue, isJSON]);

    return (
        <div className={`${styles.container} ${styles.desktopRoot}`} data-theme={theme}>
            {/* Sidebar */}
            <div className={styles.sidebar}>
                <div className={styles.sidebarHeader}>
                    <div className={styles.sidebarTitle}>连接列表</div>
                </div>
                <div className={styles.connectionList}>
                    {connections.map(c => (
                        <div
                            key={c.id}
                            onClick={() => setActiveConnectionId(c.id)}
                            className={`${styles.connectionItem} ${activeConnectionId === c.id ? styles.active : ''}`}
                        >
                            <CloudServerOutlined className={styles.connectionIcon} />
                            <span className={styles.connectionName}>{c.name}</span>
                        </div>
                    ))}
                </div>
                {activeConnectionId && (
                    <div className={styles.sidebarActions}>
                        <Button
                            size="small"
                            type="link"
                            onClick={() => disconnect(activeConnectionId)}
                        >
                            断开连接
                        </Button>
                    </div>
                )}
            </div>

            {/* Main Content */}
            <div className={styles.mainContent}>
                {!activeConnectionId ? (
                    <div className={styles.connectionForm}>
                        <h3 className={styles.formTitle}>新建 Redis 连接</h3>
                        <div className={styles.formGroup}>
                            <label className={styles.formLabel}>连接名称</label>
                            <Input
                                placeholder="例如: Local Redis"
                                value={name}
                                onChange={e => setName(e.target.value)}
                                size="small"
                            />
                        </div>
                        <div className={styles.formRow}>
                            <div className={styles.formGroup}>
                                <label className={styles.formLabel}>主机</label>
                                <Input
                                    placeholder="127.0.0.1"
                                    value={host}
                                    onChange={e => setHost(e.target.value)}
                                    size="small"
                                />
                            </div>
                            <div className={styles.formGroup}>
                                <label className={styles.formLabel}>端口</label>
                                <Input
                                    placeholder="6379"
                                    value={port}
                                    onChange={e => setPort(e.target.value)}
                                    size="small"
                                />
                            </div>
                        </div>
                        <div className={styles.formGroup}>
                            <label className={styles.formLabel}>密码（可选）</label>
                            <Input.Password
                                placeholder="留空表示无密码"
                                value={password}
                                onChange={e => setPassword(e.target.value)}
                                size="small"
                            />
                        </div>
                        <Button type="primary" size="small" icon={<LinkOutlined />} onClick={handleConnect}>
                            连接 Redis
                        </Button>
                    </div>
                ) : (
                    <>
                        {/* Toolbar */}
                        <div className={styles.toolbar}>
                            <Segmented
                                size="small"
                                value={activeTab}
                                onChange={(v) => setActiveTab(v as any)}
                                options={[
                                    { label: '键值浏览', value: 'keys' },
                                    { label: '终端控制台', value: 'terminal' },
                                ]}
                            />
                        </div>

                        {/* Content Area */}
                        <div className={styles.contentArea}>
                            {activeTab === 'keys' && (
                                <>
                                    <div className={styles.keysList}>
                                        <div className={styles.keysHeader}>
                                            <Space.Compact style={{ width: '100%' }} size="small">
                                                <Input
                                                    value={filter}
                                                    onChange={e => setFilter(e.target.value)}
                                                    placeholder="Pattern *"
                                                    size="small"
                                                />
                                                <Button
                                                    size="small"
                                                    icon={<ReloadOutlined />}
                                                    onClick={refreshKeys}
                                                />
                                            </Space.Compact>
                                        </div>
                                        <div className={styles.keysListContent}>
                                            {keys.map(k => (
                                                <div
                                                    key={k}
                                                    onClick={() => handleKeySelect(k)}
                                                    className={`${styles.keyItem} ${selectedKey === k ? styles.selected : ''}`}
                                                >
                                                    {k}
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                    <div className={styles.valueViewer}>
                                        {selectedKey ? (
                                            <>
                                                <div className={styles.keyHeaderBar}>
                                                    <div className={styles.keyHeader}>
                                                        {selectedKey}
                                                        <span className={styles.typeBadge}>{keyType}</span>
                                                    </div>
                                                    <div className={styles.keyActions}>
                                                        {!editMode && (keyType === 'string' || keyType === 'hash') && (
                                                            <Button size="small" onClick={() => setEditMode(true)}>编辑键值</Button>
                                                        )}
                                                        <Button size="small" danger icon={<DeleteOutlined />} onClick={handleDeleteKey}>删除键</Button>
                                                    </div>
                                                </div>
                                                {renderValue}
                                            </>
                                        ) : (
                                            <div className={styles.emptyState}>选择一个键以查看内容</div>
                                        )}
                                    </div>
                                </>
                            )}

                            {activeTab === 'terminal' && (
                                <div className={styles.terminal}>
                                    <div className={styles.terminalOutput}>
                                        {history.map((h, i) => (
                                            <div key={i} className={`${styles.terminalLine} ${styles[h.type === 'in' ? 'input' : h.type === 'err' ? 'error' : 'output']}`}>
                                                {h.type === 'in' ? '> ' : ''}{h.text}
                                            </div>
                                        ))}
                                    </div>
                                    <div className={styles.terminalInputArea}>
                                        <span className={styles.terminalPrompt}>redis&gt;</span>
                                        <Input
                                            value={command}
                                            onChange={e => setCommand(e.target.value)}
                                            onPressEnter={() => runCommand()}
                                            size="small"
                                            autoFocus
                                        />
                                    </div>
                                </div>
                            )}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
});
