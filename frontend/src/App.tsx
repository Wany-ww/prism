import { Route, Routes, useLocation } from 'react-router-dom';
import Shell from './Shell';
import Overview from './pages/Overview';
import EquipmentPage from './pages/EquipmentPage';
import ParsersPage from './pages/ParsersPage';
import FlowListPage from './pages/FlowListPage';
import FlowEditorPage from './pages/FlowEditorPage';
import NodeTypesPage from './pages/NodeTypesPage';
import DatasetsPage from './pages/DatasetsPage';
import TracePage from './pages/TracePage';
import DashboardListPage from './pages/DashboardListPage';
import DashboardPage from './pages/DashboardPage';
import SettingsPage from './pages/SettingsPage';

export default function App() {
  const loc = useLocation();
  if (loc.pathname.startsWith('/view/')) {
    return (
      <Routes>
        <Route path="/view/:id" element={<DashboardPage fullscreen />} />
      </Routes>
    );
  }
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Overview />} />
        <Route path="/capture/equipment" element={<EquipmentPage />} />
        <Route path="/capture/parsers" element={<ParsersPage />} />
        <Route path="/match" element={<FlowListPage kind="match" />} />
        <Route path="/match/:id" element={<FlowEditorPage kind="match" />} />
        <Route path="/analysis" element={<FlowListPage kind="analysis" />} />
        <Route path="/analysis/:id" element={<FlowEditorPage kind="analysis" />} />
        <Route path="/nodes" element={<NodeTypesPage />} />
        <Route path="/dashboards" element={<DashboardListPage />} />
        <Route path="/dashboards/:id" element={<DashboardPage />} />
        <Route path="/trace" element={<TracePage />} />
        <Route path="/datasets" element={<DatasetsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </Shell>
  );
}
