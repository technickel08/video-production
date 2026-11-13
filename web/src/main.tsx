import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import './index.css';
import { LiveProvider } from './live';
import { Layout } from './Layout';
import { Toasts } from './ui';
import Home from './pages/Home';
import Projects from './pages/Projects';
import ProjectEdit from './pages/ProjectEdit';
import Pipeline from './pages/Pipeline';
import VideoPage from './pages/Video';
import Approvals from './pages/Approvals';
import Calendar from './pages/Calendar';
import Channels from './pages/Channels';
import Settings from './pages/Settings';
import Login from './pages/Login';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LiveProvider>
      <BrowserRouter>
        <Routes>
          <Route path="login" element={<Login />} />
          <Route element={<Layout />}>
            <Route index element={<Home />} />
            <Route path="projects" element={<Projects />} />
            <Route path="projects/new" element={<ProjectEdit />} />
            <Route path="projects/:id" element={<ProjectEdit />} />
            <Route path="pipeline" element={<Pipeline />} />
            <Route path="videos/:id" element={<VideoPage />} />
            <Route path="approvals" element={<Approvals />} />
            <Route path="calendar" element={<Calendar />} />
            <Route path="channels" element={<Channels />} />
            <Route path="settings" element={<Settings />} />
          </Route>
        </Routes>
      </BrowserRouter>
      <Toasts />
    </LiveProvider>
  </StrictMode>,
);
