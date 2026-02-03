import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { IoCheckmarkCircle, IoAlertCircle, IoInformationCircle } from 'react-icons/io5';
import { Tooltip } from 'antd';
import styles from './Toast.module.css';

export type ToastType = 'success' | 'error' | 'info';

export interface ToastMessage {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
}

interface ToastContainerProps {
  toasts: ToastMessage[];
  removeToast: (id: string) => void;
}

export const ToastContainer: React.FC<ToastContainerProps> = ({ toasts, removeToast }) => {
  const body = typeof document !== 'undefined' ? document.body : null;
  const content = (
    <div className={styles.container}>
      <AnimatePresence>
        {toasts.map(toast => (
          <ToastItem key={toast.id} toast={toast} onRemove={removeToast} />
        ))}
      </AnimatePresence>
    </div>
  );
  return body ? createPortal(content, body) : content;
};

function safeJsonParse(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseMaybeJsonDeep(input: unknown, depth = 0): unknown {
  if (depth >= 3) return input;
  if (typeof input === 'string') {
    const t = input.trim();
    if (!t) return input;
    const looksJson = (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'));
    if (!looksJson) return input;
    const parsed = safeJsonParse(t);
    if (parsed === undefined) return input;
    return parseMaybeJsonDeep(parsed, depth + 1);
  }
  if (input && typeof input === 'object') {
    const anyObj = input as any;
    if (typeof anyObj.error === 'string') {
      const next = parseMaybeJsonDeep(anyObj.error, depth + 1);
      if (next !== anyObj.error) return { ...anyObj, error: next };
    }
    return input;
  }
  return input;
}

function extractSummary(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (typeof input !== 'object') return String(input);
  const anyObj = input as any;

  if (typeof anyObj.message === 'string') return anyObj.message;
  if (typeof anyObj.error === 'string') return anyObj.error;
  if (anyObj.error && typeof anyObj.error === 'object') {
    const nested = extractSummary(anyObj.error);
    if (nested) return nested;
  }
  if (anyObj.err && typeof anyObj.err === 'object') {
    const nested = extractSummary(anyObj.err);
    if (nested) return nested;
  }
  return '';
}

function truncateText(s: string, max = 140) {
  const t = String(s || '').trim();
  if (!t) return '';
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + '…';
}

const ToastItem: React.FC<{ toast: ToastMessage; onRemove: (id: string) => void }> = ({ toast, onRemove }) => {
  useEffect(() => {
    const timer = setTimeout(() => {
      onRemove(toast.id);
    }, 3000);
    return () => clearTimeout(timer);
  }, [toast.id, onRemove]);

  const getIcon = () => {
    switch (toast.type) {
      case 'success': return <IoCheckmarkCircle className={styles.icon} style={{ color: '#34C759' }} />;
      case 'error': return <IoAlertCircle className={styles.icon} style={{ color: '#FF3B30' }} />;
      default: return <IoInformationCircle className={styles.icon} style={{ color: 'var(--sentra-accent)' }} />;
    }
  };

  const rawMessage = typeof toast.message === 'string' ? toast.message : '';
  const parsed = rawMessage ? parseMaybeJsonDeep(rawMessage) : undefined;
  const summary = rawMessage ? (extractSummary(parsed) || extractSummary(rawMessage)) : '';
  const displayMessage = truncateText(summary || rawMessage, 140);
  const fullMessage = (() => {
    if (!rawMessage) return '';
    if (parsed && typeof parsed === 'object') {
      try {
        return JSON.stringify(parsed, null, 2);
      } catch {
        return rawMessage;
      }
    }
    return rawMessage;
  })();

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -20, scale: 0.9 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.2 } }}
      className={styles.toast}
    >
      {getIcon()}
      <div className={styles.content}>
        <div className={styles.title}>{toast.title}</div>
        {displayMessage ? (
          <Tooltip title={fullMessage}>
            <div className={styles.message}>{displayMessage}</div>
          </Tooltip>
        ) : null}
      </div>
    </motion.div>
  );
};