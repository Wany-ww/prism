import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App as AntApp } from 'antd';
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import '@xyflow/react/dist/style.css';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import './styles.css';
import App from './App';
import { ThemeProvider } from './theme';
import { installMotion } from './motion';

installMotion();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <AntApp>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </AntApp>
    </ThemeProvider>
  </React.StrictMode>,
);
