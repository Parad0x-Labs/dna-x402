import React from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AgentHome } from './routes/AgentHome';
import { HowItWorks } from './routes/HowItWorks';
import { Proof } from './routes/Proof';
import { Start } from './routes/Start';
import { Header } from './components/Header';
import { Footer } from './components/Footer';
import { ProgrammablePayments } from './routes/ProgrammablePayments';

const ControlRoom = React.lazy(() => import('./routes/ControlRoomWallet').then((module) => ({ default: module.ControlRoomWallet })));
const Marketplace = React.lazy(() => import('./routes/Marketplace').then((module) => ({ default: module.Marketplace })));
const PolymarketAgent = React.lazy(() => import('./routes/PolymarketAgentWallet').then((module) => ({ default: module.PolymarketAgentWallet })));
const PolymarketAlphaProfile = React.lazy(() => import('./routes/PolymarketAlphaProfile').then((module) => ({ default: module.PolymarketAlphaProfile })));
const NullTips = React.lazy(() => import('./routes/NullTipsWallet').then((module) => ({ default: module.NullTipsWallet })));

export const App: React.FC = () => {
  const location = useLocation();
  const isPolymarket = location.pathname.startsWith('/polymarket');

  return (
    <div className={`page-shell ${isPolymarket ? 'route-polymarket' : ''}`}>
      {!isPolymarket && (
        <>
          <Header />
          <nav className="top-nav">
            <Link to="/">Home</Link>
            <Link to="/control-room">Control Room</Link>
            <Link to="/how-it-works">How It Works</Link>
            <Link to="/proof">Proof</Link>
            <Link to="/start">Create Agents</Link>
            <Link to="/programmable-payments">Programmable Payments</Link>
            <Link to="/tips">NULL Tips</Link>
            <Link to="/polymarket">Polymarket Agent</Link>
          </nav>
        </>
      )}
      <main className={isPolymarket ? 'polymarket-route-wrap' : 'content-wrap'}>
        <React.Suspense fallback={<section className="panel"><p>Loading control room...</p></section>}>
          <Routes>
            <Route path="/" element={<AgentHome />} />
            <Route path="/control-room" element={<ControlRoom />} />
            <Route path="/how-it-works" element={<HowItWorks />} />
            <Route path="/proof" element={<Proof />} />
            <Route path="/start" element={<Start />} />
            <Route path="/programmable-payments" element={<ProgrammablePayments />} />
            <Route path="/tips" element={<NullTips />} />
            <Route path="/marketplace" element={<Marketplace />} />
            <Route path="/polymarket" element={<PolymarketAgent />} />
            <Route path="/polymarket/:slug" element={<PolymarketAlphaProfile />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </React.Suspense>
      </main>
      {!isPolymarket && <Footer />}
    </div>
  );
};
