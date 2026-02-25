import React from 'react';
import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { AgentHome } from './routes/AgentHome';
import { ControlRoom } from './routes/ControlRoom';
import { HowItWorks } from './routes/HowItWorks';
import { Proof } from './routes/Proof';
import { Start } from './routes/Start';
import { Header } from './components/Header';
import { Footer } from './components/Footer';

export const App: React.FC = () => (
  <div className="page-shell">
    <Header />
    <nav className="top-nav">
      <Link to="/">Home</Link>
      <Link to="/control-room">Control Room</Link>
      <Link to="/how-it-works">How It Works</Link>
      <Link to="/proof">Proof</Link>
      <Link to="/start">Start</Link>
    </nav>
    <main className="content-wrap">
      <Routes>
        <Route path="/" element={<AgentHome />} />
        <Route path="/control-room" element={<ControlRoom />} />
        <Route path="/how-it-works" element={<HowItWorks />} />
        <Route path="/proof" element={<Proof />} />
        <Route path="/start" element={<Start />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </main>
    <Footer />
  </div>
);
