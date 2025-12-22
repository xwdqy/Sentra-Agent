import React, { useState, useEffect } from 'react';
import { IoArrowForward, IoPower, IoRefresh, IoMoon } from 'react-icons/io5';
import { useDevice } from '../hooks/useDevice';
import { MacAlert } from './MacAlert';
import styles from './LoginScreen.module.css';

interface LoginScreenProps {
    onLogin: (token: string) => Promise<boolean>;
    wallpaper?: string;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({ onLogin, wallpaper }) => {
    const [token, setToken] = useState('');
    const [error, setError] = useState(false);
    const [loading, setLoading] = useState(false);
    const [shake, setShake] = useState(false);
    const [time, setTime] = useState(new Date());
    const [sleeping, setSleeping] = useState(false);
    const [showRestartAlert, setShowRestartAlert] = useState(false);
    const [showShutdownAlert, setShowShutdownAlert] = useState(false);
    const [restarting, setRestarting] = useState(false);
    const { isMobile } = useDevice();

    useEffect(() => {
        const timer = setInterval(() => setTime(new Date()), 1000);
        return () => clearInterval(timer);
    }, []);

    const handleSubmit = async (e?: React.FormEvent) => {
        e?.preventDefault();
        if (!token.trim()) return;

        setLoading(true);
        setError(false);

        try {
            const success = await onLogin(token);
            if (!success) {
                handleError();
            }
        } catch (err) {
            handleError();
        } finally {
            setLoading(false);
        }
    };

    const handleError = () => {
        setError(true);
        setShake(true);
        setTimeout(() => setShake(false), 500);
        setToken('');
    };

    const handleSleep = () => {
        setSleeping(true);
        setError(false);
        setToken('');
    };

    const handleRestartConfirm = () => {
        // 登录页仅需要刷新配置中心前端，不调用 /api/system/restart（未登录无法通过鉴权）
        setRestarting(true);
        setTimeout(() => {
            window.location.reload();
        }, 500);
    };

    const handleShutdownConfirm = () => {
        try {
            window.open('', '_self');
            window.close();
        } catch { }

        // 某些浏览器不允许直接关闭窗口时，退回到空白页
        window.location.href = 'about:blank';
    };

    const formatTime = (date: Date) => {
        return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: false });
    };

    const formatDate = (date: Date) => {
        return date.toLocaleDateString('zh-CN', { weekday: 'long', month: 'long', day: 'numeric' });
    };

    return (
        <div
            className={styles.container}
            style={{
                backgroundImage: wallpaper ? `url(${wallpaper})` : 'none',
            }}
        >
            {/* Optimized Overlay */}
            <div className={styles.overlay} />

            {sleeping && (
                <div className={styles.sleepOverlay} onClick={() => setSleeping(false)}>
                    <div className={styles.sleepClock}>
                        <IoMoon size={28} />
                        <div className={styles.sleepHint}>已进入睡眠 · 点击任意位置唤醒</div>
                    </div>
                </div>
            )}

            {/* Top Section: Clock */}
            <div className={styles.clockSection}>
                <div className={styles.time}>
                    {formatTime(time)}
                </div>
                <div className={styles.date}>
                    {formatDate(time)}
                </div>
            </div>

            {/* Center Section: Login Form */}
            <div className={styles.loginSection}>
                {/* Avatar */}
                <div className={styles.avatarContainer}>
                    <img
                        src="/sentra.png"
                        alt="User"
                        className={styles.avatarImg}
                    />
                    {loading && <div className={styles.loadingSpinner} />}
                </div>

                <div className={styles.username}>
                    管理员
                </div>

                {/* Input Area */}
                <form
                    onSubmit={handleSubmit}
                    className={styles.form}
                    style={shake ? { animation: 'shake 0.4s cubic-bezier(.36,.07,.19,.97) both' } : {}}
                >
                    <div className={styles.inputWrapper}>
                        <input
                            type="password"
                            value={token}
                            onChange={(e) => {
                                setToken(e.target.value);
                                setError(false);
                            }}
                            placeholder="输入密码"
                            autoFocus
                            className={styles.input}
                        />
                        <button
                            type="submit"
                            disabled={!token || loading}
                            className={`${styles.submitBtn} ${token ? styles.visible : ''}`}
                        >
                            <IoArrowForward size={18} color="#333" />
                        </button>
                    </div>
                </form>

                {error && (
                    <div className={styles.errorMessage}>
                        密码错误
                    </div>
                )}
            </div>

            {/* Bottom Status Bar */}
            {!isMobile && (
                <div className={styles.footer}>
                    <div className={styles.footerAction} onClick={handleSleep}>
                        <div className={styles.actionIcon}>
                            <IoMoon size={20} />
                        </div>
                        <span>睡眠</span>
                    </div>
                    <div className={styles.footerAction} onClick={() => setShowRestartAlert(true)}>
                        <div className={styles.actionIcon}>
                            <IoRefresh size={20} />
                        </div>
                        <span>重启</span>
                    </div>
                    <div className={styles.footerAction} onClick={() => setShowShutdownAlert(true)}>
                        <div className={styles.actionIcon}>
                            <IoPower size={20} />
                        </div>
                        <span>关机</span>
                    </div>
                </div>
            )}

            {/* Mac-style Alerts for Restart & Shutdown */}
            <MacAlert
                isOpen={showRestartAlert}
                title="重启配置中心"
                message="确定要重启配置管理页面吗？这将重新连接后端服务。"
                onClose={() => setShowRestartAlert(false)}
                onConfirm={handleRestartConfirm}
                confirmText="重启"
                cancelText="取消"
                isDanger={false}
            />

            <MacAlert
                isOpen={showShutdownAlert}
                title="关闭配置中心"
                message="确定要关闭配置管理页面吗？要再次使用需重新打开本页面。"
                onClose={() => setShowShutdownAlert(false)}
                onConfirm={handleShutdownConfirm}
                confirmText="关机"
                cancelText="取消"
                isDanger={true}
            />

            {restarting && (
                <div className={styles.restartingOverlay}>
                    <div className={styles.restartingSpinner} />
                    <div className={styles.restartingText}>正在重启配置管理界面...</div>
                    <div className={styles.restartingSubtext}>页面将自动刷新</div>
                </div>
            )}
        </div>
    );
};
