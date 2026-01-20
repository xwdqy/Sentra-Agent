import React from 'react';
import ReactDOM from 'react-dom/client';
import { App as AntdApp, ConfigProvider } from 'antd';
import App from './App';
import { storage } from './utils/storage';

const storedSystemFont = (() => {
  const v = storage.getString('sentra_system_font', { fallback: '' });
  return v || null;
})();

if (storedSystemFont) {
  document.documentElement.style.setProperty('--system-font', storedSystemFont);
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      getPopupContainer={() => document.body}
      theme={{
        token: {
          fontFamily: 'var(--system-font)',
          zIndexPopupBase: 5000,
        },
      }}
    >
      <AntdApp>
        <App />
      </AntdApp>
    </ConfigProvider>
  </React.StrictMode>
);
