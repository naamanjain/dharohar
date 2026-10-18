import React, { createContext, useContext, useState, useEffect } from 'react';
import {
  ActiveView,
  BulkBatch,
  DistrictMetric,
  DocumentRecord,
  LandOwner,
  QualityEnhancements,
  UserProfile,
  LandParcel,
  BackendHealthInfo,
  ValidationError,
} from '../types';
import { SAMPLE_DOCUMENTS } from '../data/sampleDocuments';
import { BULK_BATCHES, DISTRICT_METRICS, USER_PROFILES } from '../data/mockData';
import { INITIAL_SEED_PARCELS } from '../data/seedParcels';
import {
  preprocessDocumentImage,
  recognizeDocumentText,
  parseRevenueRecord,
  SAMPLE_JAMABANDI_OCR_TEXT,
  SAMPLE_KHASRA_GIRDAWARI_OCR_TEXT,
  SAMPLE_MUTATION_OCR_TEXT,
} from '../services/ocr';
import {
  fetchBackendHealth,
  fetchParcelsFromBackend,
  createParcelOnBackend,
  updateParcelOnBackend,
  archiveParcelOnBackend,
  linkDocumentOnBackend,
  sealRecordOnBackend,
  loginToBackend,
  setStoredAuthToken,
  hasStoredAuthSession,
  ApiError,
} from '../services/api/client';
import { TRANSLATIONS } from '../i18n/translations';

interface AppNotification {
  id: string;
  title: string;
  message: string;
  type: 'success' | 'warning' | 'error' | 'info';
  timestamp: string;
}

interface AppContextType {
  currentUser: UserProfile;
  isAuthenticated: boolean;
  isLoggedIn: boolean;
  activeView: ActiveView;
  documents: DocumentRecord[];
  activeDocument: DocumentRecord | null;
  batches: BulkBatch[];
  districtMetrics: DistrictMetric[];
  notifications: AppNotification[];
  systemLanguage: 'en' | 'hi';
  backendHealth: BackendHealthInfo;
  /**
   * 'connected'  - the API authenticated this officer; writes persist.
   * 'demo'       - the API could not be reached; the session is local-only and says so.
   * 'failed'     - the API rejected the credentials.
   */
  backendSession: 'connected' | 'demo' | 'failed';
  checkBackendStatus: () => Promise<void>;
  toggleLanguage: () => void;
  setLanguage: (lang: 'en' | 'hi') => void;
  login: (user: UserProfile, password: string) => Promise<void>;
  logout: () => void;
  setActiveView: (view: ActiveView) => void;
  selectDocument: (id: string, targetView?: ActiveView) => void;
  uploadDocument: (newDoc: Partial<DocumentRecord>) => DocumentRecord;
  updateQualityEnhancements: (docId: string, enhancements: Partial<QualityEnhancements>) => void;
  runProcessingSimulation: (
    docId: string,
    onStep?: (stage: string, progress: number, logText?: string, logType?: 'info' | 'success' | 'warn') => void
  ) => Promise<void>;
  updateExtractedFieldValue: (docId: string, fieldPath: string, value: any, note?: string) => void;
  updateOwner: (docId: string, ownerId: string, updatedFields: Partial<LandOwner>) => void;
  addOwner: (docId: string, owner: LandOwner) => void;
  removeOwner: (docId: string, ownerId: string) => void;
  resolveValidationError: (docId: string, errorId: string, note?: string) => void;
  verifyAndSealRecord: (docId: string, notes: string) => Promise<void>;
  acceptExtractedRecord: (docId: string) => void;
  rejectRecord: (docId: string, reason: string) => void;
  flagForPatwariInspection: (docId: string, instructions: string) => void;
  addNotification: (title: string, message: string, type?: 'success' | 'warning' | 'error' | 'info') => void;
  dismissNotification: (id: string) => void;
  startBatchProcessing: (batchId: string) => Promise<void>;
  createBatch: (batch: Omit<BulkBatch, 'id'>) => BulkBatch;
  parcels: LandParcel[];
  activeParcels: LandParcel[];
  activeParcel: LandParcel | null;
  selectParcel: (id: string) => void;
  createParcel: (parcel: Omit<LandParcel, 'id' | 'createdAt'>) => LandParcel;
  updateParcel: (id: string, patch: Partial<LandParcel>) => void;
  linkDocumentToParcel: (documentId: string, parcelId: string) => void;
  deleteParcel: (parcelId: string) => void;
  archiveParcel: (parcelId: string, reason?: string) => void;
  refreshParcels: () => Promise<void>;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [currentUser, setCurrentUser] = useState<UserProfile>(() => {
    try {
      const saved = localStorage.getItem('dharohar.currentUser.v1');
      return saved ? JSON.parse(saved) as UserProfile : USER_PROFILES[0];
    } catch { return USER_PROFILES[0]; }
  });
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(() => {
    try { return sessionStorage.getItem('dharohar.auth.v3') === 'true'; } catch { return false; }
  });
  const [activeView, setActiveView] = useState<ActiveView>(() => {
    try {
      const saved = sessionStorage.getItem('dharohar.activeView.v3') as ActiveView | null;
      return saved || (sessionStorage.getItem('dharohar.auth.v3') === 'true' ? 'dashboard' : 'login');
    } catch { return 'login'; }
  });

  const [documents, setDocuments] = useState<DocumentRecord[]>(() => {
    try {
      const saved = localStorage.getItem('dharohar.documents.v1');
      if (saved) {
        const parsed = JSON.parse(saved) as DocumentRecord[];
        if (Array.isArray(parsed) && parsed.length) return parsed;
      }
    } catch {
      // Fall back to sample documents when local storage is malformed.
    }
    return SAMPLE_DOCUMENTS;
  });

  // Parcels single source of truth is PostgreSQL/PostGIS.
  // Purge any stale legacy localStorage parcel data so it cannot override backend records.
  const [parcels, setParcels] = useState<LandParcel[]>(() => {
    try {
      localStorage.removeItem('dharohar.parcels.v1');
    } catch {}
    return INITIAL_SEED_PARCELS;
  });

  const [activeParcelId, setActiveParcelId] = useState<string>(() => {
    try { return localStorage.getItem('dharohar.activeParcel.v1') || 'DH-JPR-RAM-001024'; } catch { return 'DH-JPR-RAM-001024'; }
  });
  const [activeDocumentId, setActiveDocumentId] = useState<string>(() => {
    try { return localStorage.getItem('dharohar.activeDocument.v1') || SAMPLE_DOCUMENTS[0].id; } catch { return SAMPLE_DOCUMENTS[0].id; }
  });
  const [batches, setBatches] = useState<BulkBatch[]>(BULK_BATCHES);
  const [districtMetrics, setDistrictMetrics] = useState<DistrictMetric[]>(DISTRICT_METRICS);
  const [backendHealth, setBackendHealth] = useState<BackendHealthInfo>({
    status: 'dev-fallback',
    storageMode: 'dev-fallback',
    postgisAvailable: false,
    lastSync: new Date().toISOString(),
  });
  const [backendSession, setBackendSession] = useState<'connected' | 'demo' | 'failed'>('demo');
  const [systemLanguage, setSystemLanguageState] = useState<'en' | 'hi'>(() => {
    try {
      const saved = localStorage.getItem('dharohar.language.v1');
      return saved === 'hi' || saved === 'en' ? saved : 'en';
    } catch {
      return 'en';
    }
  });
  const [notifications, setNotifications] = useState<AppNotification[]>([
    {
      id: 'notif-1',
      title: systemLanguage === 'hi' ? 'धरोहर प्रणाली ऑनलाइन' : 'DHAROHAR System Online',
      message: systemLanguage === 'hi'
        ? 'धरोहर स्थानिक भू-पंजीका प्रारंभ हुई। स्थलीय सत्यापन तक सीमाएं अनंतिम रहेंगी।'
        : 'DHAROHAR spatial registry initialized. Parcel boundaries remain provisional until field verified.',
      type: 'info',
      timestamp: systemLanguage === 'hi' ? 'अभी' : 'Just now',
    },
  ]);

  const activeParcels = parcels.filter((p) => p.status !== 'Archived' && !p.isArchived);
  // Falling back to documents[0]/activeParcels[0] meant every verification and seal view silently
  // operated on whichever record happened to be first once the selection went stale.
  const activeDocument = documents.find((d) => d.id === activeDocumentId) || null;
  const activeParcel = activeParcels.find((p) => p.id === activeParcelId) || null;

  const applyBackendParcels = (backendParcels: LandParcel[]) => {
    if (!Array.isArray(backendParcels) || backendParcels.length === 0) return;
    setParcels(backendParcels);
    setActiveParcelId((prev) => {
      const stillActive = backendParcels.some((p) => p.id === prev && p.status !== 'Archived' && !p.isArchived);
      if (stillActive) return prev;
      const next = backendParcels.find((p) => p.status !== 'Archived' && !p.isArchived);
      return next ? next.id : '';
    });
  };

  const refreshParcels = async () => {
    try {
      const res = await fetchParcelsFromBackend();
      applyBackendParcels(res.parcels);
    } catch (err) {
      console.warn('[DHAROHAR DB] Error refreshing parcels from backend:', err);
    }
  };

  const checkBackendStatus = async () => {
    try {
      const health = await fetchBackendHealth();
      setBackendHealth(health);
      // Parcel reads need a session; before login this would 401 on every mount.
      if (health.status === 'connected' && hasStoredAuthSession()) {
        const res = await fetchParcelsFromBackend();
        applyBackendParcels(res.parcels);
        // A reload with an existing token never runs login(), so the session state is restored
        // here from evidence rather than left at its 'demo' initial value.
        setBackendSession('connected');
      }
    } catch (err) {
      // A rejected token used to be logged and ignored, leaving the officer on an
      // authenticated-looking dashboard fed by bundled mock parcels.
      if (err instanceof ApiError && err.status === 401) {
        setStoredAuthToken(null);
        setBackendSession('failed');
        setIsAuthenticated(false);
        setActiveView('login');
        addNotification(
          systemLanguage === 'hi' ? 'सत्र समाप्त' : 'Session expired',
          systemLanguage === 'hi'
            ? 'सर्वर ने आपका टोकन अस्वीकार कर दिया। कृपया पुनः प्रवेश करें — नीचे दिखाए जा रहे अभिलेख सहेजे गए नहीं हैं।'
            : 'The server rejected your session token. Please sign in again — the records shown were not coming from the database.',
          'warning'
        );
        return;
      }
      console.warn('[DHAROHAR DB] Backend health check failed:', err);
    }
  };

  useEffect(() => {
    checkBackendStatus();
  }, []);

  useEffect(() => {
    try { localStorage.setItem('dharohar.documents.v1', JSON.stringify(documents)); } catch {}
  }, [documents]);

  useEffect(() => {
    try {
      sessionStorage.setItem('dharohar.auth.v3', String(isAuthenticated));
      sessionStorage.setItem('dharohar.activeView.v3', isAuthenticated ? activeView : 'login');
      localStorage.removeItem('dharohar.auth.v1');
      localStorage.removeItem('dharohar.activeView.v1');
      sessionStorage.removeItem('dharohar.auth.v2');
      sessionStorage.removeItem('dharohar.activeView.v2');
      if (currentUser) localStorage.setItem('dharohar.currentUser.v1', JSON.stringify(currentUser));
      if (activeParcelId) localStorage.setItem('dharohar.activeParcel.v1', activeParcelId);
      if (activeDocumentId) localStorage.setItem('dharohar.activeDocument.v1', activeDocumentId);
    } catch {
      // Best-effort prototype persistence.
    }
  }, [isAuthenticated, activeView, currentUser, activeParcelId, activeDocumentId]);

  const setLanguage = (lang: 'en' | 'hi') => {
    setSystemLanguageState(lang);
    try {
      localStorage.setItem('dharohar.language.v1', lang);
    } catch {}
  };

  const toggleLanguage = () => {
    setSystemLanguageState((prev) => {
      const next = prev === 'en' ? 'hi' : 'en';
      try {
        localStorage.setItem('dharohar.language.v1', next);
      } catch {}
      return next;
    });
  };

  const login = async (user: UserProfile, password: string) => {
    if (!password) {
      addNotification(
        systemLanguage === 'hi' ? 'पासवर्ड आवश्यक है' : 'Password required',
        systemLanguage === 'hi' ? 'अधिकारी प्रवेश के लिए पासवर्ड दर्ज करें।' : 'Enter the officer password to sign in.',
        'error'
      );
      return;
    }

    try {
      // user.id matches the backend's `id = $2` lookup, so personas resolve without email guessing.
      const session = await loginToBackend(user.id, password);
      if (!session?.token) throw new ApiError('The server did not return a session token.', 401);

      setStoredAuthToken(session.token);
      setCurrentUser({
        ...user,
        name: session.user?.displayName || user.name,
        badgeNumber: session.user?.badgeNumber || user.badgeNumber,
        district: session.user?.district || user.district,
        role: session.user?.role,
        email: session.user?.email,
      });
      setBackendSession('connected');
      setIsAuthenticated(true);
      setActiveView('dashboard');
      // The registry has to come from the database the moment a session exists; until this ran
      // the dashboard showed bundled seed parcels while the header claimed PostgreSQL + PostGIS.
      await checkBackendStatus();
      addNotification(
        systemLanguage === 'hi' ? 'सर्व-प्रमाणित लॉगिन' : 'Server-authenticated login',
        systemLanguage === 'hi'
          ? `${session.user?.displayName || user.name} (${session.user?.role || user.designation}) के रूप में प्रवेश। लेखन PostgreSQL में सहेजे जाएंगे।`
          : `Signed in as ${session.user?.displayName || user.name} (${session.user?.role || user.designation}). Writes persist to the database.`,
        'success'
      );
    } catch (err: any) {
      setStoredAuthToken(null);

      // status 0 means the API is unreachable, not that the credentials were wrong. Without a
      // server the persona picker is a demo, and the session has to say so instead of pretending.
      const unreachable = err instanceof ApiError && err.status === 0;
      if (unreachable) {
        setCurrentUser({ ...user, role: undefined });
        setBackendSession('demo');
        setIsAuthenticated(true);
        setActiveView('dashboard');
        addNotification(
          systemLanguage === 'hi' ? 'डेमो सत्र' : 'Demo session',
          systemLanguage === 'hi'
            ? 'सर्वर उपलब्ध नहीं: यह सत्र केवल स्थानीय है और कोई अभिलेख सहेजा नहीं जाएगा।'
            : 'API server unreachable — this session is local only. Nothing you seal or save will persist.',
          'warning'
        );
        return;
      }

      setBackendSession('failed');
      addNotification(
        systemLanguage === 'hi' ? 'लॉगिन अस्वीकृत' : 'Login refused',
        err instanceof ApiError ? err.message : 'Could not sign in.',
        'error'
      );
    }
  };

  const logout = () => {
    setIsAuthenticated(false);
    setActiveView('login');
    setBackendSession('demo');
    setStoredAuthToken(null);
    try {
      sessionStorage.removeItem('dharohar.auth.v3');
      sessionStorage.removeItem('dharohar.activeView.v3');
      sessionStorage.removeItem('dharohar.auth.v2');
      sessionStorage.removeItem('dharohar.activeView.v2');
      localStorage.removeItem('dharohar.auth.v1');
      localStorage.removeItem('dharohar.activeView.v1');
    } catch {}
  };

  const selectDocument = (id: string, targetView?: ActiveView) => {
    setActiveDocumentId(id);
    if (targetView) {
      setActiveView(targetView);
    }
  };

  const selectParcel = (id: string) => {
    const parcel = parcels.find((p) => p.id === id);
    if (!parcel) return;
    setActiveParcelId(id);
    if (parcel.documentId) setActiveDocumentId(parcel.documentId);
  };

  const createParcel = (parcel: Omit<LandParcel, 'id' | 'createdAt'>): LandParcel => {
    const districtCode = (parcel.district || 'RJ').replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'RJ';
    const villageCode = (parcel.village || 'LAND').replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'LAN';
    const nextNumber = parcels.reduce((max, p) => {
      const match = p.id.match(/(\d{6})$/);
      return Math.max(max, match ? Number(match[1]) : 0);
    }, 1023) + 1;
    const id = `DH-${districtCode}-${villageCode}-${String(nextNumber).padStart(6, '0')}`;
    const created: LandParcel = { ...parcel, id, createdAt: new Date().toISOString() };
    setParcels(prev => [created, ...prev.filter(p => p.id !== id)]);
    setActiveParcelId(id);
    if (created.documentId) setActiveDocumentId(created.documentId);
    addNotification(
      systemLanguage === 'hi' ? 'पार्सल सृजित हुआ' : 'Parcel Created',
      systemLanguage === 'hi' ? `${id} को डिजिटल भू-अभिलेख से लिंक कर दिया गया है।` : `${id} is now linked to a digital land record.`,
      'success'
    );

    // Synchronize with the PostgreSQL backend. Failure is reported to the officer: until it
    // succeeds the parcel exists only in this browser.
    createParcelOnBackend(created)
      .then(({ parcel, storageMode }) => {
        if (parcel) setParcels((prev) => prev.map((p) => (p.id === id ? parcel : p)));
        if (storageMode !== 'postgres-postgis') {
          addNotification(
            systemLanguage === 'hi' ? 'केवल अस्थायी सृजन' : 'Created in memory only',
            systemLanguage === 'hi'
              ? `${id} सर्वर की अस्थायी स्मृति में है; PostgreSQL में सहेजा नहीं गया है।`
              : `${id} is held in the server's temporary memory, not PostgreSQL. It will be lost on restart.`,
            'warning'
          );
        }
      })
      .catch((err) => {
        addNotification(
          systemLanguage === 'hi' ? 'पार्सल सर्वर पर सहेजा नहीं गया' : 'Parcel not saved to server',
          err instanceof ApiError
            ? `${err.message} ${id} exists only in this browser.`
            : `${id} could not be sent to the server and exists only in this browser.`,
          'error'
        );
      });

    return created;
  };

  const updateParcel = (id: string, patch: Partial<LandParcel>) => {
    setParcels((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
    if (patch.documentId) setActiveDocumentId(patch.documentId);

    updateParcelOnBackend(id, patch)
      .then(({ parcel }) => {
        if (parcel) setParcels((prev) => prev.map((p) => (p.id === id ? parcel : p)));
      })
      .catch((err) => {
        addNotification(
          systemLanguage === 'hi' ? 'अपडेट सहेजा नहीं गया' : 'Update not saved',
          err instanceof ApiError ? err.message : `Parcel ${id} update failed.`,
          'error'
        );
      });
  };

  const archiveParcel = (parcelId: string, reason = 'Archived from active registry.') => {
    setParcels((prev) => prev.map((parcel) =>
      parcel.id === parcelId
        ? { ...parcel, status: 'Archived', isArchived: true, archivedAt: new Date().toISOString(), archiveReason: reason }
        : parcel
    ));
    setActiveParcelId((current) => current === parcelId ? '' : current);
    addNotification(
      systemLanguage === 'hi' ? 'पार्सल अभिलेखागार में भेजा गया' : 'Parcel Archived',
      systemLanguage === 'hi' ? `${parcelId} सक्रिय पंजिका से हटा दिया गया है।` : `${parcelId} moved out of the active registry.`,
      'warning'
    );

    archiveParcelOnBackend(parcelId, reason).catch((err) => {
      addNotification(
        systemLanguage === 'hi' ? 'आर्काइव सर्वर पर सहेजा नहीं गया' : 'Archive not recorded on server',
        err instanceof ApiError ? err.message : `${parcelId} was archived locally only.`,
        'error'
      );
    });
  };

  // Mandatory Rule: No permanent hard delete. deleteParcel delegates to archiveParcel.
  const deleteParcel = (parcelId: string) => {
    archiveParcel(parcelId, 'Archived via removal request (soft-deleted).');
  };


  const linkDocumentToParcel = (documentId: string, parcelId: string) => {
    const matchedDoc = documents.find((d) => d.id === documentId);
    const previousDocuments = documents;
    const previousParcels = parcels;
    const displacedDoc = documents.find((d) => d.parcelId === parcelId && d.id !== documentId);

    setDocuments((prev) => prev.map((doc) => {
      if (doc.id === documentId) return { ...doc, parcelId };
      if (doc.parcelId === parcelId) return { ...doc, parcelId: undefined };
      return doc;
    }));

    setParcels((prev) => prev.map((parcel) => {
      if (parcel.id === parcelId) {
        return matchedDoc
          ? {
            ...parcel,
            documentId,
            documentDisplayId: documentId,
            documentName: matchedDoc.fileName,
            documentType: matchedDoc.recordType,
            documentUploadedAt: matchedDoc.uploadedAt,
            documentUri: matchedDoc.imageUri,
          }
          : { ...parcel, documentId };
      }
      if (parcel.documentId === documentId) {
        return { ...parcel, documentId: undefined, documentName: undefined, documentType: undefined, documentUploadedAt: undefined, documentDisplayId: undefined, documentUri: undefined };
      }
      return parcel;
    }));
    setActiveDocumentId(documentId);

    // One write does both sides: POST /documents/:id/link sets land_documents.parcel_id and the
    // parcel's document pointer in the same transaction as its audit entry. Before this the link
    // existed only in this browser, so the database kept saying the record belonged to no parcel and
    // the attachment disappeared on reload.
    linkDocumentOnBackend(documentId, parcelId)
      .then((result) => {
        if (result.district) {
          setDocuments((prev) => prev.map((doc) => (doc.id === documentId ? { ...doc, district: result.district ?? doc.district } : doc)));
        }
      })
      .catch((err) => {
        setDocuments(previousDocuments);
        setParcels(previousParcels);
        addNotification(
          systemLanguage === 'hi' ? 'दस्तावेज़ जोड़ा नहीं गया' : 'Document not linked',
          err instanceof ApiError ? err.message : (systemLanguage === 'hi' ? 'सर्वर से संपर्क नहीं हुआ।' : 'The server could not be reached.'),
          'error'
        );
      });

    if (displacedDoc) {
      linkDocumentOnBackend(displacedDoc.id, null).catch((err) => {
        addNotification(
          systemLanguage === 'hi' ? 'पुराना लिंक नहीं हटाया गया' : 'Previous link not released',
          err instanceof ApiError ? err.message : `Could not detach ${displacedDoc.id} from ${parcelId}.`,
          'warning'
        );
      });
    }
  };

  const addNotification = (
    title: string,
    message: string,
    type: 'success' | 'warning' | 'error' | 'info' = 'info'
  ) => {
    const newNotif: AppNotification = {
      id: `notif-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
      title,
      message,
      type,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    };
    setNotifications((prev) => {
      const withoutDuplicate = prev.filter((n) => !(n.title === title && n.message === message));
      return [newNotif, ...withoutDuplicate].slice(0, 5);
    });
  };

  const dismissNotification = (id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  };

  const uploadDocument = (newDocData: Partial<DocumentRecord>): DocumentRecord => {
    const docId = `DOC-RAJ-2025-${Math.floor(10000 + Math.random() * 90000)}`;
    const randomCode = `RJ-${(newDocData.district || 'JPR').substring(0, 3).toUpperCase()}-${(
      newDocData.village || 'VIL'
    )
      .substring(0, 4)
      .toUpperCase()}-${Math.floor(1000 + Math.random() * 9000)}`;

    const newRecord: DocumentRecord = {
      id: docId,
      documentCode: randomCode,
      fileName: newDocData.fileName || 'Scanned_Land_Record_Sheet.pdf',
      uploadedAt: new Date().toLocaleString([], {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
      recordType: newDocData.recordType || 'Jamabandi (RoR - Record of Rights)',
      district: newDocData.district || 'Jaipur',
      tehsil: newDocData.tehsil || 'Sanganer',
      village: newDocData.village || 'Rampur',
      patwarCircle: newDocData.patwarCircle || 'PC-01 Main Circle',
      status: 'Uploaded',
      priority: newDocData.priority || 'Medium',
      imageUri: newDocData.imageUri || 'jamabandi_sample_1',
      // Nothing has been measured yet, so nothing is claimed. These used to default to dpi 300,
      // blur 89, score 91 and passed:true — an unmeasured upload that cleared the quality gate.
      qualityMetrics: newDocData.qualityMetrics || {
        dpi: 0,
        skewAngle: 0,
        blurScore: 0,
        lighting: 'Not measured',
        stainsAndFolds: 'Not measured',
        contrastRatio: 0,
        overallScore: 0,
        passed: false,
      },
      qualityEnhancements: {
        deskew: false,
        deskewAngle: 0,
        binarize: false,
        denoise: true,
        contrastBoost: true,
        sharpen: true,
        invertColors: false,
        brightness: 0,
        contrast: 100,
        zoom: 100,
      },
      data: newDocData.data || {
        khasraNo: {
          value: '315/2',
          hindiValue: '३१५/२',
          originalOcr: '315/2',
          confidence: 94.5,
          bbox: { id: 'b-new1', field: 'khasraNo', x: 22, y: 18, width: 15, height: 4, confidence: 94.5 },
        },
        khatauniNo: {
          value: '84',
          hindiValue: '८४',
          originalOcr: '84',
          confidence: 92.0,
          bbox: { id: 'b-new2', field: 'khatauniNo', x: 42, y: 18, width: 12, height: 4, confidence: 92.0 },
        },
        khewatNo: {
          value: '22',
          hindiValue: '२२',
          originalOcr: '22',
          confidence: 95.0,
          bbox: { id: 'b-new3', field: 'khewatNo', x: 62, y: 18, width: 10, height: 4, confidence: 95.0 },
        },
        villageMauza: {
          value: newDocData.village || 'Rampur',
          hindiValue: 'रामपुर',
          originalOcr: newDocData.village || 'Rampur',
          confidence: 98.0,
        },
        patwarCircle: {
          value: 'PC-01 Main Circle',
          hindiValue: 'पटवार वृत्त ०१',
          originalOcr: 'PC-01 Main Circle',
          confidence: 96.0,
        },
        tehsil: {
          value: newDocData.tehsil || 'Sanganer',
          hindiValue: 'सांगानेर',
          originalOcr: newDocData.tehsil || 'Sanganer',
          confidence: 97.5,
        },
        district: {
          value: newDocData.district || 'Jaipur',
          hindiValue: 'जयपुर',
          originalOcr: newDocData.district || 'Jaipur',
          confidence: 99.0,
        },
        state: {
          value: 'Rajasthan',
          hindiValue: 'राजस्थान',
          originalOcr: 'Rajasthan',
          confidence: 100.0,
        },
        settlementYear: {
          value: '2024-2025',
          hindiValue: '२०२४-२५',
          originalOcr: '2024-2025',
          confidence: 95.0,
        },
        owners: [
          {
            id: 'own-new-1',
            name: 'Harish Chandra Verma',
            hindiName: 'हरीश चन्द्र वर्मा',
            relationType: 's/o',
            relativeName: 'Ganga Ram Verma',
            relativeHindiName: 'गंगा राम वर्मा',
            shareFraction: '1/2',
            sharePercentage: 50.0,
            casteOrCategory: 'General / Mahajan',
            aadhaarRef: 'XXXX-XXXX-8812',
            status: 'Active Co-sharer',
          },
          {
            id: 'own-new-2',
            name: 'Prakash Chandra Verma',
            hindiName: 'प्रकाश चन्द्र वर्मा',
            relationType: 's/o',
            relativeName: 'Ganga Ram Verma',
            relativeHindiName: 'गंगा राम वर्मा',
            shareFraction: '1/2',
            sharePercentage: 50.0,
            casteOrCategory: 'General / Mahajan',
            aadhaarRef: 'XXXX-XXXX-9943',
            status: 'Active Co-sharer',
          },
        ],
        rakbaArea: {
          bigha: 5,
          biswa: 4,
          biswansi: 0,
          totalHectares: 1.315,
          standardAcre: 3.25,
          confidence: 93.0,
        },
        landClassification: {
          value: 'Chahi (Well Irrigated)',
          hindiValue: 'चाही (सिंचित)',
          originalOcr: 'Chahi Irrigated',
          confidence: 91.0,
        },
        soilClass: {
          value: 'Domat II',
          hindiValue: 'दोमट द्वितीय',
          originalOcr: 'Domat II',
          confidence: 90.0,
        },
        annualLagaanRevenue: {
          value: 290.0,
          originalOcr: 'Rs. 290.00',
          confidence: 95.0,
        },
        encumbrance: {
          isMortgaged: false,
          courtInjunctionActive: false,
          remarks: 'No active lien found in registry.',
        },
        mutationDetails: {
          lastMutationNo: 'Mut-2023/419',
          mutationDate: '04-Oct-2023',
          mutationType: 'Sale Deed (Bainama)',
          approvingAuthority: 'Tehsildar Sanganer',
        },
      },
      ocrEngines: {
        tesseractConfidence: 93.5,
        trocrConfidence: 95.2,
        indicOcrConfidence: 96.0,
        ensembleConfidence: 94.9,
        characterErrorRate: 1.1,
        processingTimeMs: 1100,
      },
      validationErrors: [],
      auditTrail: {
        uploadedBy: currentUser.name,
        processedAt: undefined,
      },
      processingLogs: [
        {
          timestamp: new Date().toLocaleTimeString(),
          stage: 'Upload',
          message: 'Document uploaded and registered in digitization cache.',
          level: 'info',
        },
      ],
    };

    setDocuments((prev) => [newRecord, ...prev]);
    setActiveDocumentId(docId);
    addNotification(
      systemLanguage === 'hi' ? 'दस्तावेज़ पंजीकृत' : 'Document Registered',
      systemLanguage === 'hi' ? `${newRecord.fileName} सफलतापूर्वक प्रविष्ट किया गया।` : `${newRecord.fileName} ingested successfully.`,
      'success'
    );
    return newRecord;
  };

  const updateQualityEnhancements = (docId: string, enhancements: Partial<QualityEnhancements>) => {
    setDocuments((prev) =>
      prev.map((doc) => {
        if (doc.id === docId) {
          const updated = {
            ...doc,
            qualityEnhancements: { ...doc.qualityEnhancements, ...enhancements },
          };
          return updated;
        }
        return doc;
      })
    );
  };

  const runProcessingSimulation = async (
    docId: string,
    onStep?: (stage: string, progress: number, logText?: string, logType?: 'info' | 'success' | 'warn') => void
  ): Promise<void> => {
    const doc = documents.find((d) => d.id === docId);
    if (!doc) return;

    const startTime = Date.now();

    // Stage 1: Preprocessing & Alignment
    onStep?.(
      'Stage 1/4: Image Preprocessing & Deskew Alignment',
      20,
      `Analyzing raster buffer and applying image filters for ${doc.fileName} (${doc.documentCode})`,
      'info'
    );

    let parsedRecord: ReturnType<typeof parseRevenueRecord>;
    let ocrEngineConfidence = 0;
    let simulated = false;
    let ocrFailure: string | null = null;

    // Check if document has uploaded Data URL or image
    if (doc.imageUri && (doc.imageUri.startsWith('data:image/') || doc.imageUri.startsWith('blob:') || doc.imageUri.startsWith('http'))) {
      try {
        onStep?.(
          'Stage 1/4: Image Preprocessing & Deskew Alignment',
          25,
          `Applied deskew (${doc.qualityEnhancements.deskewAngle}°), adaptive thresholding, and contrast filter.`,
          'success'
        );

        const preprocessed = await preprocessDocumentImage(doc.imageUri, {
          deskewAngle: doc.qualityEnhancements.deskew ? doc.qualityEnhancements.deskewAngle : 0,
          contrastBoost: doc.qualityEnhancements.contrastBoost,
          binarize: doc.qualityEnhancements.binarize,
          sharpen: doc.qualityEnhancements.sharpen,
          brightness: doc.qualityEnhancements.brightness,
        });

        // Stage 2: Tesseract OCR
        onStep?.(
          'Stage 2/4: Local Tesseract OCR (Devanagari + English)',
          45,
          'Initializing in-browser Tesseract WASM neural worker (eng+hin)...',
          'info'
        );

        const ocrOutput = await recognizeDocumentText(preprocessed.processedCanvas, {
          language: 'eng+hin',
          onProgress: (p) => {
            const mappedProgress = Math.min(75, Math.max(45, Math.round(45 + p.progress * 0.3)));
            onStep?.('Stage 2/4: Local Tesseract OCR (Devanagari + English)', mappedProgress, `Worker: ${p.status}`, 'info');
          },
        });

        if (ocrOutput.success && ocrOutput.fullText.trim().length > 0) {
          ocrEngineConfidence = ocrOutput.confidence;
          onStep?.(
            'Stage 2/4: Local Tesseract OCR (Devanagari + English)',
            75,
            `Local OCR completed with ${ocrEngineConfidence}% confidence across ${ocrOutput.lines.length} lines.`,
            'success'
          );
          parsedRecord = parseRevenueRecord(ocrOutput);
        } else {
          // No text means no record. The prototype parsed a hardcoded sample Jamabandi instead,
          // so a failed scan produced a complete, plausible record for the wrong land.
          ocrFailure = ocrOutput.success
            ? 'OCR finished but read no text from this image.'
            : ocrOutput.error || 'The OCR worker reported a failure.';
          parsedRecord = parseRevenueRecord('');
        }
      } catch (ocrErr: any) {
        ocrFailure = `OCR engine error: ${ocrErr?.message || String(ocrErr)}`;
        onStep?.(
          'Stage 2/4: Local OCR Engine',
          75,
          'Local recognition failed. No fields were guessed from the image.',
          'warn'
        );
        parsedRecord = parseRevenueRecord('');
      }
    } else {
      // Preset sample documents: the fixture text is the input, so the result is a demonstration
      // of the parser, not a reading of the officer's scan. The UI is told it is simulated.
      simulated = true;
      const isSkewed = doc.fileName.includes('Kothari') || doc.fileName.includes('77A');
      const isMutation = doc.fileName.includes('Mandore') || doc.fileName.includes('1092') || doc.recordType.includes('Mutation');
      const sampleRawText = isSkewed
        ? SAMPLE_KHASRA_GIRDAWARI_OCR_TEXT
        : isMutation
        ? SAMPLE_MUTATION_OCR_TEXT
        : SAMPLE_JAMABANDI_OCR_TEXT;

      ocrEngineConfidence = 0;
      await new Promise((r) => setTimeout(r, 400));
      onStep?.(
        'Stage 1/4: Image Preprocessing & Deskew Alignment',
        25,
        'SIMULATED: bundled sample text used. No image was processed.',
        'warn'
      );
      await new Promise((r) => setTimeout(r, 550));
      onStep?.(
        'Stage 2/4: Local OCR Recognition (Devanagari + English)',
        65,
        'SIMULATED: parsing bundled sample OCR text (not a reading of a scan).',
        'warn'
      );
      parsedRecord = parseRevenueRecord(sampleRawText);
    }

    // Stage 3: Entity Extraction & Domain NER
    onStep?.(
      'Stage 3/4: Entity Extraction & Revenue Lexicon Parser',
      85,
      `Extracted Khasra ${parsedRecord.data.khasraNo.value}, Khatauni ${parsedRecord.data.khatauniNo.value}, Rakba ${parsedRecord.data.rakbaArea.bigha}B-${parsedRecord.data.rakbaArea.biswa}B, ${parsedRecord.data.owners.length} Co-sharers.`,
      'info'
    );
    await new Promise((r) => setTimeout(r, 450));

    // Stage 4: Cross-reference Cadastral Grid
    onStep?.(
      'Stage 4/4: Cadastral Survey Cross-Reference & Rule Validation',
      100,
      `Geo-Cadastral verification finished with ${parsedRecord.validationErrors.length} discrepancies flagged.`,
      'success'
    );
    await new Promise((r) => setTimeout(r, 300));

    const totalProcessingTime = Date.now() - startTime;

    const failureError: ValidationError | null = ocrFailure
      ? {
          id: 'val-ocr-no-text',
          ruleCode: 'RULE-OCR-NO-TEXT',
          category: 'OCR Quality',
          severity: 'Critical',
          title: systemLanguage === 'hi' ? 'ओसीआर से कोई पाठ नहीं मिला' : 'OCR produced no text',
          description: `${ocrFailure} No field values below were read from this document.`,
          suggestedAction:
            systemLanguage === 'hi'
              ? 'छवि को बेहतर रिज़ॉल्यूशन पर पुनः स्कैन करें, या फ़ील्ड manually भरें।'
              : 'Re-scan the image at higher resolution, or transcribe the fields manually.',
          resolved: false,
        }
      : null;

    setDocuments((prev) =>
      prev.map((d) => {
        if (d.id === docId) {
          return {
            ...d,
            data: {
              ...parsedRecord.data,
              district: d.district ? { ...parsedRecord.data.district, value: d.district } : parsedRecord.data.district,
              tehsil: d.tehsil ? { ...parsedRecord.data.tehsil, value: d.tehsil } : parsedRecord.data.tehsil,
              villageMauza: d.village ? { ...parsedRecord.data.villageMauza, value: d.village } : parsedRecord.data.villageMauza,
            },
            rawOcrText: parsedRecord.rawText,
            ocrLanguage: 'hin+eng',
            isAccepted: false,
            isSimulated: simulated,
            // Only Tesseract actually runs. The prototype reported TrOCR and IndicOCR scores it
            // had never measured, so officers saw three engines they could not hold accountable.
            ocrEngines: {
              tesseractConfidence: Number(ocrEngineConfidence.toFixed(1)),
              trocrConfidence: 0,
              indicOcrConfidence: 0,
              ensembleConfidence: Number(ocrEngineConfidence.toFixed(1)),
              characterErrorRate: ocrEngineConfidence > 0
                ? Number(Math.max(0.4, (100 - ocrEngineConfidence) / 10).toFixed(1))
                : 100,
              processingTimeMs: totalProcessingTime,
            },
            validationErrors: failureError
              ? [failureError, ...parsedRecord.validationErrors]
              : parsedRecord.validationErrors,
            status: failureError
              ? 'Under Review'
              : parsedRecord.validationErrors.length > 0
              ? 'Pending Verification'
              : 'Extraction Ready',
            auditTrail: {
              ...d.auditTrail,
              processedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            },
            processingLogs: [
              ...d.processingLogs,
              {
                timestamp: new Date().toLocaleTimeString(),
                stage: 'OCR Pipeline',
                message: simulated
                  ? `Bundled sample text parsed in ${(totalProcessingTime / 1000).toFixed(2)}s (SIMULATED - no image was read).`
                  : failureError
                  ? `Processing finished in ${(totalProcessingTime / 1000).toFixed(2)}s with NO usable OCR text. Fields are empty by design.`
                  : `Local OCR & entity parsing completed in ${(totalProcessingTime / 1000).toFixed(2)}s with ${ocrEngineConfidence}% confidence.`,
                level: failureError || simulated ? 'warning' : 'success',
              },
            ],
          };
        }
        return d;
      })
    );

    addNotification(
      failureError
        ? (systemLanguage === 'hi' ? 'ओसीआर विफल' : 'OCR produced no text')
        : (systemLanguage === 'hi' ? 'ओसीआर प्रसंस्करण संपन्न' : 'OCR Processing Finished'),
      failureError
        ? (systemLanguage === 'hi'
            ? `${doc.documentCode}: कोई पाठ नहीं मिला। निकाले गए मान खाली हैं, इन्हें सत्यापित मानकर आगे नहीं बढ़ें।`
            : `${doc.documentCode}: no text was read. Extracted fields are empty, not verified values.`)
        : (systemLanguage === 'hi'
            ? `दस्तावेज़ ${doc.documentCode} का विवरण निकाला गया एवं शजरा मिलान पूर्ण हुआ।`
            : `Document ${doc.documentCode} extracted and cross-referenced.`),
      failureError ? 'error' : 'success'
    );
  };

  const updateExtractedFieldValue = (docId: string, fieldPath: string, value: any, note?: string) => {
    const doc = documents.find((d) => d.id === docId);
    const currentField = doc?.data ? (doc.data as any)[fieldPath] : undefined;
    const writable = Boolean(doc?.data) && currentField && typeof currentField === 'object' && !Array.isArray(currentField);

    if (!writable) {
      addNotification(
        systemLanguage === 'hi' ? 'फ़ील्ड अद्यतन नहीं हुआ' : 'Field not updated',
        systemLanguage === 'hi'
          ? `'${fieldPath}' एक संपादन योग्य निकाला-हुआ फ़ील्ड नहीं है; कोई बदलाव नहीं किया गया।`
          : `'${fieldPath}' is not an editable extracted field, so nothing was changed.`,
        'error'
      );
      return;
    }

    setDocuments((prev) =>
      prev.map((d) => {
        if (d.id === docId && d.data) {
          const clonedData = { ...d.data } as any;
          const existing = clonedData[fieldPath];
          clonedData[fieldPath] = {
            ...existing,
            value,
            manualOverride: true,
            isFlagged: false,
            flagReason: undefined,
          };
          return {
            ...d,
            data: clonedData,
            auditTrail: {
              ...d.auditTrail,
              verificationNotes: note
                ? `${d.auditTrail.verificationNotes || ''}\n[Modified ${fieldPath}]: ${note}`
                : d.auditTrail.verificationNotes,
            },
          };
        }
        return d;
      })
    );
    addNotification(
      systemLanguage === 'hi' ? 'विवरण अद्यतित' : 'Field Updated',
      systemLanguage === 'hi' ? `फ़ील्ड '${fieldPath}' को "${value}" पर अद्यतित किया गया।` : `Field '${fieldPath}' updated to "${value}".`,
      'info'
    );
  };

  // Ownership percentage is the canonical numeric value. Fractions are a
  // human-readable representation and are normalized with a small tolerance
  // so repeating fractions such as 1/3 can safely display as 33.33%.
  const fractionToPercentage = (fraction: string): number | null => {
    const match = String(fraction || '').trim().match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
    if (!match) return null;
    const denominator = Number(match[2]);
    if (!Number.isFinite(denominator) || denominator <= 0) return null;
    const numerator = Number(match[1]);
    if (!Number.isFinite(numerator) || numerator < 0) return null;
    return Number((numerator / denominator * 100).toFixed(2));
  };

  const percentageToFraction = (percentage: number): string => {
    const pct = Number(percentage.toFixed(2));
    const common: Array<[number, string]> = [
      [100, '1/1'],
      [50, '1/2'],
      [25, '1/4'],
      [33.33, '1/3'],
      [66.67, '2/3'],
      [12.5, '1/8'],
      [20, '1/5'],
      [40, '2/5'],
      [60, '3/5'],
      [75, '3/4'],
    ];
    const exact = common.find(([value]) => Math.abs(value - pct) <= 0.005);
    if (exact) return exact[1];

    // Keep the percentage itself as the fallback representation. It round-trips
    // without inventing a mathematically different ownership share.
    return `${pct.toFixed(2).replace(/\.?0+$/, '')}/100`;
  };

  const normalizeOwnerShare = (owner: LandOwner, patch: Partial<LandOwner>): LandOwner => {
    const next = { ...owner, ...patch };

    if ('sharePercentage' in patch) {
      const numeric = Number(next.sharePercentage);
      if (Number.isFinite(numeric)) {
        const pct = Math.min(100, Math.max(0, Number(numeric.toFixed(2))));
        next.sharePercentage = pct;
        next.shareFraction = percentageToFraction(pct);
      }
    } else if ('shareFraction' in patch) {
      const pct = fractionToPercentage(String(next.shareFraction));
      if (pct != null) {
        next.sharePercentage = pct;
        next.shareFraction = percentageToFraction(pct);
      }
    }

    return next;
  };

  const updateOwner = (docId: string, ownerId: string, updatedFields: Partial<LandOwner>) => {
    setDocuments((prev) =>
      prev.map((doc) => {
        if (doc.id === docId) {
          const newOwners = doc.data.owners.map((o) => (o.id === ownerId ? normalizeOwnerShare(o, updatedFields) : o));
          return {
            ...doc,
            data: {
              ...doc.data,
              owners: newOwners,
            },
          };
        }
        return doc;
      })
    );
    addNotification(
      systemLanguage === 'hi' ? 'खातेदार विवरण अद्यतित' : 'Owner Record Updated',
      systemLanguage === 'hi' ? 'खातेदार विवरण एवं सह-खातेदारी स्थिति सहेजी गई।' : 'Owner details and co-sharer status saved.',
      'info'
    );
  };

  const addOwner = (docId: string, owner: LandOwner) => {
    setDocuments((prev) =>
      prev.map((doc) => {
        if (doc.id === docId) {
          return {
            ...doc,
            data: {
              ...doc.data,
              owners: [...doc.data.owners, owner],
            },
          };
        }
        return doc;
      })
    );
    addNotification(
      systemLanguage === 'hi' ? 'सह-खातेदार जोड़ा गया' : 'Co-Sharer Added',
      systemLanguage === 'hi' ? `${owner.name} को स्वामित्व पंजिका में जोड़ा गया।` : `${owner.name} appended to ownership ledger.`,
      'success'
    );
  };

  const removeOwner = (docId: string, ownerId: string) => {
    setDocuments((prev) =>
      prev.map((doc) => {
        if (doc.id === docId) {
          return {
            ...doc,
            data: {
              ...doc.data,
              owners: doc.data.owners.filter((o) => o.id !== ownerId),
            },
          };
        }
        return doc;
      })
    );
    addNotification(
      systemLanguage === 'hi' ? 'सह-खातेदार हटाया गया' : 'Co-Sharer Removed',
      systemLanguage === 'hi' ? 'खातेदार को अभिलेख सारणी से हटाया गया।' : 'Owner removed from record table.',
      'warning'
    );
  };

  const resolveValidationError = (docId: string, errorId: string, note?: string) => {
    setDocuments((prev) =>
      prev.map((doc) => {
        if (doc.id === docId) {
          const updatedErrors = doc.validationErrors.map((err) =>
            err.id === errorId
              ? {
                  ...err,
                  resolved: true,
                  resolvedBy: currentUser.name,
                  resolutionNote: note || 'Resolved by Verification Officer after manual inspection.',
                }
              : err
          );
          return {
            ...doc,
            validationErrors: updatedErrors,
          };
        }
        return doc;
      })
    );
    addNotification(
      systemLanguage === 'hi' ? 'विसंगति निस्तारित' : 'Discrepancy Resolved',
      systemLanguage === 'hi' ? 'नियम सत्यापन त्रुटि को स्वीकृत/निस्तारित के रूप में चिह्नित किया गया।' : 'Rule validation error marked as cleared.',
      'success'
    );
  };

  const verifyAndSealRecord = async (docId: string, notes: string) => {
    const docToSeal = documents.find((d) => d.id === docId);
    if (!docToSeal) {
      addNotification(
        systemLanguage === 'hi' ? 'कोई दस्तावेज़ चयनित नहीं' : 'No document selected',
        systemLanguage === 'hi' ? 'सील लगाने से पहले एक दस्तावेज़ चुनें।' : 'Select a record before applying a seal.',
        'error'
      );
      return;
    }

    // Terminal and pre-seal states. The prototype sealed anything, including documents that had
    // been rejected, already sealed, or never extracted at all.
    if (docToSeal.status === 'Verified') {
      addNotification(
        systemLanguage === 'hi' ? 'पहले से सीलबंद' : 'Already sealed',
        systemLanguage === 'hi'
          ? `${docToSeal.documentCode} पहले से सत्यापित है; पुनः-सील से प्रमाण-पत्र बदला नहीं जा सकता।`
          : `${docToSeal.documentCode} already carries a certificate. Re-sealing is not permitted.`
        ,
        'warning'
      );
      return;
    }
    if (docToSeal.status === 'Rejected' || !docToSeal.data) {
      addNotification(
        systemLanguage === 'hi' ? 'सील अस्वीकृत' : 'Seal refused',
        systemLanguage === 'hi'
          ? `${docToSeal.documentCode} अस्वीकृत या असंसाधित है; सील के योग्य नहीं।`
          : `${docToSeal.documentCode} is rejected or has not been extracted; it cannot be sealed.`,
        'error'
      );
      return;
    }

    if (currentUser.role && currentUser.role !== 'TEHSILDAR') {
      addNotification(
        systemLanguage === 'hi' ? 'अधिकारी आवश्यक' : 'Tehsildar authority required',
        systemLanguage === 'hi'
          ? `आपकी भूमिका (${currentUser.role}) अंतिम सील नहीं लगा सकती।`
          : `Signed in as ${currentUser.role}; only a Tehsildar may apply the final seal.`,
        'error'
      );
      return;
    }

    const docKhasra = docToSeal.data?.khasraNo?.value;
    const linkedParcel = parcels.find(
      (p) =>
        p.documentDisplayId === docId ||
        (docKhasra && p.khasraNo && p.khasraNo.includes(docKhasra)) ||
        (activeParcel && (activeParcel.documentDisplayId === docId || activeParcel.khasraNo === docKhasra))
    );

    let seal: { certificateNumber: string; signatureHash: string; sealedAt: string; storageMode: string };
    try {
      seal = await sealRecordOnBackend({
        parcelId: linkedParcel?.id,
        documentId: docId,
        officerNotes: notes || 'Verified against Master Shajra Cadastre.',
      });
    } catch (err) {
      addNotification(
        systemLanguage === 'hi' ? 'सील लागू नहीं हुई' : 'Seal not applied',
        err instanceof ApiError
          ? err.message
          : 'The seal could not be recorded. The record remains unverified.',
        'error'
      );
      return;
    }

    if (!seal.certificateNumber) {
      addNotification(
        systemLanguage === 'hi' ? 'सील लागू नहीं हुई' : 'Seal not applied',
        'The server did not issue a certificate number. The record remains unverified.',
        'error'
      );
      return;
    }

    if (linkedParcel) {
      updateParcel(linkedParcel.id, {
        status: 'Verified',
        verifiedBy: currentUser.name,
        verifiedAt: seal.sealedAt,
        verificationNotes: notes || 'Verified accurate in accordance with Rajasthan Land Revenue Act 1956.',
      });
    }

    setDocuments((prev) =>
      prev.map((doc) => {
        if (doc.id === docId) {
          return {
            ...doc,
            status: 'Verified',
            auditTrail: {
              ...doc.auditTrail,
              verifiedBy: currentUser.name,
              verifiedAt: new Date(seal.sealedAt).toLocaleString([], {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              }),
              verifierBadge: currentUser.badgeNumber,
              digitalSignatureHash: seal.signatureHash,
              certificateNumber: seal.certificateNumber,
              qrPayload: `DHAROHAR|VERIFY|${seal.certificateNumber}`,
              verificationNotes: notes || 'Verified accurate in accordance with Rajasthan Land Revenue Act 1956.',
            },
          };
        }
        return doc;
      })
    );

    setDistrictMetrics((prev) =>
      prev.map((dm) => (dm.district === currentUser.district ? { ...dm, verifiedRecords: dm.verifiedRecords + 1 } : dm))
    );

    const notDurable = seal.storageMode !== 'postgres-postgis';
    addNotification(
      systemLanguage === 'hi' ? 'भू-अभिलेख सत्यापित एवं डिजिटल रूप से सीलबंद' : 'Land Record Verified & Digitally Sealed',
      notDurable
        ? systemLanguage === 'hi'
          ? `प्रमाण-पत्र #${seal.certificateNumber} जारी, परंतु सर्वर स्मति-मोड में है: यह सील स्थायी नहीं है।`
          : `Certificate #${seal.certificateNumber} issued, but the server is in memory mode — this seal is NOT durable.`
        : systemLanguage === 'hi'
          ? `प्रमाण-पत्र संख्या #${seal.certificateNumber} डिजिटल हस्ताक्षर-मुहर के साथ जारी किया गया और PostgreSQL में सहेजा गया।`
          : `Certificate #${seal.certificateNumber} issued with an HMAC seal signature and stored in PostgreSQL.`,
      notDurable ? 'warning' : 'success'
    );
  };

  const acceptExtractedRecord = (docId: string) => {
    setDocuments((prev) =>
      prev.map((doc) => {
        if (doc.id === docId) {
          return {
            ...doc,
            isAccepted: true,
            status: doc.validationErrors.length > 0 ? 'Pending Verification' : 'Extraction Ready',
            auditTrail: {
              ...doc.auditTrail,
              verificationNotes: doc.auditTrail.verificationNotes
                ? `${doc.auditTrail.verificationNotes}\n[Extraction Accepted]: Confirmed by ${currentUser.name}.`
                : `[Extraction Accepted]: Confirmed by ${currentUser.name}.`,
            },
          };
        }
        return doc;
      })
    );
    addNotification(
      systemLanguage === 'hi' ? 'अभिलेख विवरण स्वीकृत' : 'Record Accepted',
      systemLanguage === 'hi'
        ? 'निकाले गए भू-अभिलेख विवरण को स्वीकार किया गया। नियम सत्यापन हेतु तैयार।'
        : 'Extracted land record fields accepted by officer. Ready for compliance validation.',
      'success'
    );
  };

  const rejectRecord = (docId: string, reason: string) => {
    setDocuments((prev) =>
      prev.map((doc) => {
        if (doc.id === docId) {
          return {
            ...doc,
            status: 'Rejected',
            auditTrail: {
              ...doc.auditTrail,
              verificationNotes: `REJECTED by ${currentUser.name}: ${reason}`,
            },
          };
        }
        return doc;
      })
    );
    addNotification(
      systemLanguage === 'hi' ? 'अभिलेख अस्वीकृत' : 'Record Rejected',
      systemLanguage === 'hi' ? `दस्तावेज़ अस्वीकृत चिह्नित: ${reason}` : `Document marked rejected: ${reason}`,
      'error'
    );
  };

  const flagForPatwariInspection = (docId: string, instructions: string) => {
    setDocuments((prev) =>
      prev.map((doc) => {
        if (doc.id === docId) {
          return {
            ...doc,
            status: 'Flagged for Patwari',
            auditTrail: {
              ...doc.auditTrail,
              patwariRemarks: instructions,
            },
          };
        }
        return doc;
      })
    );
    addNotification(
      systemLanguage === 'hi' ? 'पटवारी को प्रेषित' : 'Forwarded to Patwari',
      systemLanguage === 'hi' ? 'हल्का पटवारी को स्थलीय निरीक्षण आदेश जारी किया गया।' : 'Field inspection order dispatched to Halka Patwari.',
      'warning'
    );
  };

  const startBatchProcessing = async (batchId: string) => {
    const batch = batches.find((b) => b.id === batchId);
    if (!batch) return;

    // Batches carry no document rows in this build, so "allocating worker threads" was a claim
    // with nothing behind it and left the batch stuck in OCR In Progress permanently.
    const docs = batch.documents || [];
    if (docs.length === 0) {
      addNotification(
        systemLanguage === 'hi' ? 'बैच में दस्तावेज़ नहीं' : 'Batch has no documents',
        systemLanguage === 'hi'
          ? `${batchId} में कोई दस्तावेज़ सूचीबद्ध नहीं है; प्रसंस्करण प्रारंभ नहीं किया गया।`
          : `${batchId} lists no document rows, so there is nothing to process. Upload documents and link them to this batch first.`,
        'warning'
      );
      return;
    }

    setBatches((prev) => prev.map((b) => (b.id === batchId ? { ...b, status: 'OCR In Progress' } : b)));

    let processed = 0;
    let failed = 0;
    for (const doc of docs) {
      try {
        await runProcessingSimulation(doc.id);
        processed += 1;
      } catch {
        failed += 1;
      }
      setBatches((prev) =>
        prev.map((b) => (b.id === batchId ? { ...b, processedCount: processed, failedCount: failed } : b))
      );
    }

    setBatches((prev) =>
      prev.map((b) =>
        b.id === batchId
          ? { ...b, status: failed > 0 ? 'Validation Ready' : 'Completed', processedCount: processed, failedCount: failed }
          : b
      )
    );

    addNotification(
      systemLanguage === 'hi' ? 'बैच प्रसंस्करण समाप्त' : 'Batch processing finished',
      systemLanguage === 'hi'
        ? `${batchId}: ${processed} संपन्न, ${failed} विफल।`
        : `${batchId}: ${processed} processed, ${failed} failed.`,
      failed > 0 ? 'warning' : 'success'
    );
  };

  const createBatch = (batch: Omit<BulkBatch, 'id'>): BulkBatch => {
    const id = `BATCH-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`;
    const created: BulkBatch = { ...batch, id };
    setBatches((prev) => [created, ...prev]);
    return created;
  };

  return (
    <AppContext.Provider
      value={{
        currentUser,
        isAuthenticated,
        isLoggedIn: isAuthenticated,
        activeView,
        documents,
        activeDocument,
        batches,
        districtMetrics,
        notifications,
        systemLanguage,
        backendHealth,
        backendSession,
        checkBackendStatus,
        toggleLanguage,
        setLanguage,
        login,
        logout,
        setActiveView,
        selectDocument,
        uploadDocument,
        updateQualityEnhancements,
        runProcessingSimulation,
        updateExtractedFieldValue,
        updateOwner,
        addOwner,
        removeOwner,
        resolveValidationError,
        verifyAndSealRecord,
        acceptExtractedRecord,
        rejectRecord,
        flagForPatwariInspection,
        addNotification,
        dismissNotification,
        startBatchProcessing,
        createBatch,
        linkDocumentToParcel,
        deleteParcel,
        archiveParcel,
        parcels,
        activeParcels,
        activeParcel,
        selectParcel,
        createParcel,
        updateParcel,
        refreshParcels,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
};
