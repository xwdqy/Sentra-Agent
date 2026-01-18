import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider } from 'antd';
import App from './App';

const storedSystemFont = (() => {
  try {
    return localStorage.getItem('sentra_system_font');
  } catch {
    return null;
  }
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
      <App />
    </ConfigProvider>
  </React.StrictMode>
);
