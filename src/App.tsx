import React from 'react';
import { AppProvider, useApp } from './context/AppContext';
import { AppLayout } from './components/layout/AppLayout';
import { LoginView } from './components/views/LoginView';
import { DashboardView } from './components/views/DashboardView';
import { DocumentUploadView } from './components/views/DocumentUploadView';
import { QualityCheckView } from './components/views/QualityCheckView';
import { ProcessingView } from './components/views/ProcessingView';
import { ExtractionResultsView } from './components/views/ExtractionResultsView';
import { RecordValidationView } from './components/views/RecordValidationView';
import { VerificationQueueView } from './components/views/VerificationQueueView';
import { HumanVerificationView } from './components/views/HumanVerificationView';
import { FieldVerificationView } from './components/views/FieldVerificationView';
import { VerifiedRecordView } from './components/views/VerifiedRecordView';
import { BulkProcessingView } from './components/views/BulkProcessingView';
import { DigitizationReportsView } from './components/views/DigitizationReportsView';
import { SpatialRegistryView } from './components/views/SpatialRegistryView';
import { ErrorBoundary } from './components/common/ErrorBoundary';

const MainContent: React.FC = () => {
  const { isLoggedIn, activeView } = useApp();

  if (!isLoggedIn) {
    return <LoginView />;
  }

  const renderActiveView = () => {
    switch (activeView) {
      case 'dashboard':
        return <DashboardView />;
      case 'spatial_registry':
        return <SpatialRegistryView />;
      case 'upload':
        return <DocumentUploadView />;
      case 'quality_check':
        return <QualityCheckView />;
      case 'processing':
        return <ProcessingView />;
      case 'extraction_results':
        return <ExtractionResultsView />;
      case 'record_validation':
        return <RecordValidationView />;
      case 'verification_queue':
        return <VerificationQueueView />;
      case 'human_verification':
        return <HumanVerificationView />;
      case 'field_verification':
        return <FieldVerificationView />;
      case 'verified_record':
        return <VerifiedRecordView />;
      case 'bulk_processing':
        return <BulkProcessingView />;
      case 'digitization_reports':
      case 'reports':
        return <DigitizationReportsView />;
      default:
        return <DashboardView />;
    }
  };

  return <ErrorBoundary><AppLayout>{renderActiveView()}</AppLayout></ErrorBoundary>;
};

export default function App() {
  return (
    <AppProvider>
      <MainContent />
    </AppProvider>
  );
}
