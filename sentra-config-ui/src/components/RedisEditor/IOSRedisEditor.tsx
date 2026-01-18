import React, { useState, useEffect } from 'react';
import styles from './IOSRedisEditor.module.css';
import { Button, Input, Segmented, Space } from 'antd';
import { CloudServerOutlined, DeleteOutlined, KeyOutlined, ArrowLeftOutlined, ReloadOutlined, LinkOutlined } from '@ant-design/icons';
import { useRedisEditor } from '../../hooks/useRedisEditor';
import Editor from '@monaco-editor/react';
import '../../utils/monacoSetup';

interface IOSRedisEditorProps {
    state: ReturnType<typeof useRedisEditor>;
}

export const IOSRedisEditor: React.FC<IOSRedisEditorProps> = ({ state }) => {
    const [host, setHost] = useState('127.0.0.1');
    const [port, setPort] = useState('6379');
    const [password, setPassword] = useState('');
    const [name, setName] = useState('Local Redis');
    const [activeTab, setActiveTab] = useState<'keys' | 'terminal'>('keys');
    const [view, setView] = useState<'connections' | 'keys' | 'value'>('connections');

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
            setView('keys');
            refreshKeys();
        } else {
            setKeys([]);
            setHistory([]);
            setView('connections');
        }
    }, [activeConnectionId]);

    const handleConnect = async () => {
        await connect(name, host, parseInt(port), password || undefined);
    };

    const refreshKeys = async () => {
        if (!activeConnectionId) return;
        const res = await executeCommand(activeConnectionId, 'KEYS', [filter]);
        if (res.success && Array.isArray(res.result)) {
            setKeys(res.result.sort());
        }
    };

    const handleKeySelect = async (key: string) => {
        if (!activeConnectionId) return;
        setSelectedKey(key);
        setEditMode(false);
        setView('value');

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

    const handleSaveValue = async () => {
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
            handleKeySelect(selectedKey);
        } catch (err) {
            console.error('Save failed', err);
        }
    };

    const handleDeleteKey = async () => {
        if (!activeConnectionId || !selectedKey) return;
        await executeCommand(activeConnectionId, 'DEL', [selectedKey]);
        setSelectedKey(null);
        setKeyValue(null);
        setView('keys');
        refreshKeys();
    };

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

    const renderValue = () => {
        if (!keyValue) return null;

        // For editing mode
        if (editMode && (keyType === 'string' || keyType === 'hash')) {
            return (
                <div className={styles.editorContainer}>
                    <Editor
                        height="300px"
                        language={keyType === 'string' && isJSON(editedValue) ? 'json' : 'plaintext'}
                        value={editedValue}
                        onChange={(val) => setEditedValue(val || '')}
                        theme="vs-dark"
                        options={{
                            minimap: { enabled: false },
                            fontSize: 14,
                            wordWrap: 'on',
                        }}
                    />
                    <div className={styles.editActions}>
                        <Button size="small" type="primary" onClick={handleSaveValue}>保存</Button>
                        <Button size="small" onClick={() => setEditMode(false)}>取消</Button>
                    </div>
                </div>
            );
        }

        // Visual preview for different types
        if (keyType === 'hash' && typeof keyValue === 'object') {
            return (
                <div className={styles.hashView}>
                    {Object.entries(keyValue).map(([field, value]) => (
                        <div key={field} className={styles.hashItem}>
                            <div className={styles.fieldName}>{field}</div>
                            <div className={styles.fieldValue}>{String(value)}</div>
                        </div>
                    ))}
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

        if (keyType === 'string') {
            const strValue = String(keyValue);
            if (isJSON(strValue)) {
                try {
                    const parsed = JSON.parse(strValue);
                    return (
                        <div className={styles.jsonView}>
                            <Editor
                                height="300px"
                                language="json"
                                value={JSON.stringify(parsed, null, 2)}
                                theme="vs-dark"
                                options={{
                                    readOnly: true,
                                    minimap: { enabled: false },
                                    fontSize: 14,
                                    wordWrap: 'on',
                                }}
                            />
                        </div>
                    );
                } catch { }
            }
            return <Input.TextArea value={strValue} readOnly className={styles.valueContent} autoSize={{ minRows: 6, maxRows: 16 }} />;
        }

        return <div className={styles.emptyState}>不支持的数据类型</div>;
    };

    const isJSON = (str: string) => {
        try {
            JSON.parse(str);
            return true;
        } catch {
            return false;
        }
    };

    // Connections View
    if (view === 'connections') {
        return (
            <div className={styles.container}>
                {connections.length > 0 && (
                    <div className={styles.connectionsList}>
                        <div className={styles.sectionTitle}>已保存的连接</div>
                        {connections.map(c => (
                            <div
                                key={c.id}
                                onClick={() => setActiveConnectionId(c.id)}
                                className={styles.connectionCard}
                            >
                                <CloudServerOutlined />
                                <div className={styles.connectionInfo}>
                                    <div className={styles.connectionName}>{c.name}</div>
                                    <div className={styles.connectionHost}>{c.host}:{c.port}</div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
                <div className={styles.connectForm}>
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
            </div>
        );
    }

    // Keys View
    if (view === 'keys') {
        return (
            <div className={styles.container}>
                <div className={styles.toolbar}>
                    <Button size="small" icon={<ArrowLeftOutlined />} onClick={() => setView('connections')}>
                        连接
                    </Button>
                    <Segmented
                        size="small"
                        value={activeTab}
                        onChange={(v) => setActiveTab(v as any)}
                        options={[
                            { label: '键值浏览', value: 'keys' },
                            { label: '终端', value: 'terminal' },
                        ]}
                    />
                    <Button size="small" danger onClick={() => disconnect(activeConnectionId!)}>
                        断开
                    </Button>
                </div>

                {activeTab === 'keys' ? (
                    <>
                        <div className={styles.searchBar}>
                            <Space.Compact style={{ width: '100%' }} size="small">
                                <Input
                                    value={filter}
                                    onChange={e => setFilter(e.target.value)}
                                    placeholder="Pattern *"
                                    size="small"
                                />
                                <Button size="small" icon={<ReloadOutlined />} onClick={refreshKeys} />
                            </Space.Compact>
                        </div>
                        <div className={styles.keysList}>
                            {keys.map(k => (
                                <div
                                    key={k}
                                    onClick={() => handleKeySelect(k)}
                                    className={styles.keyCard}
                                >
                                    <KeyOutlined />
                                    <span className={styles.keyName}>{k}</span>
                                </div>
                            ))}
                        </div>
                    </>
                ) : (
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
                                className={styles.terminalInput}
                            />
                        </div>
                    </div>
                )}
            </div>
        );
    }

    // Value View
    return (
        <div className={styles.container}>
            <div className={styles.valueHeader}>
                <Button size="small" icon={<ArrowLeftOutlined />} onClick={() => setView('keys')}>返回</Button>
                <div className={styles.valueActions}>
                    {!editMode && (keyType === 'string' || keyType === 'hash') && (
                        <Button size="small" onClick={() => setEditMode(true)}>编辑</Button>
                    )}
                    <Button size="small" danger icon={<DeleteOutlined />} onClick={handleDeleteKey} />
                </div>
            </div>
            <div className={styles.keyInfo}>
                <div className={styles.keyName}>{selectedKey}</div>
                <span className={styles.typeBadge}>{keyType}</span>
            </div>
            <div className={styles.valueContainer}>
                {renderValue()}
            </div>
        </div>
    );
};
