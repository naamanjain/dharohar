import React from 'react';

interface Props { children: React.ReactNode; }
interface State { hasError: boolean; }

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
  }
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error('DHAROHAR UI error:', error);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="max-w-lg w-full bg-white border border-rose-200 rounded-2xl p-6 shadow-sm">
          <div className="text-sm font-bold text-rose-900">DHAROHAR encountered a UI error</div>
          <p className="text-xs text-slate-600 mt-2">Your saved prototype records remain in this browser. Reload the page to recover the workspace.</p>
          <button onClick={() => window.location.reload()} className="mt-4 px-4 py-2 bg-slate-900 text-white rounded-lg text-xs font-semibold">Reload workspace</button>
        </div>
      </div>
    );
  }
}
