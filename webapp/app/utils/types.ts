export type HealthStatus = 'UNKNOWN' | 'HEALTHY' | 'DOWN';
export type ServiceStatus = 'ACTIVE' | 'DISABLED' | 'SUSPENDED';
export type BackupStatus = 'RECEIVED' | 'PROCESSING' | 'SUCCESS' | 'FAILED';
export type DestinationType = 'PRIVATE_CHAT' | 'GROUP' | 'GROUP_TOPIC' | 'CHANNEL';

export interface Limits {
  maxServices: number;
  maxBackupBytes: number;
  apiRateLimit: string;
  backupRateLimit: string;
  heartbeatRateLimit: string;
}

export interface Me {
  id: string;
  telegramId: number;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  isAdmin: boolean;
  isRootAdmin: boolean;
  notifyHealth: boolean;
  notifyBackupFailures: boolean;
  limits: Limits;
  serviceCount: number;
}

export interface Service {
  id: string;
  name: string;
  description: string | null;
  status: ServiceStatus;
  apiEnabled: boolean;
  destinationId: string | null;
  healthEnabled: boolean;
  healthNotify: boolean;
  healthStatus: HealthStatus;
  healthIntervalSeconds: number;
  healthGraceSeconds: number;
  lastHeartbeatAt: string | null;
  wentDownAt: string | null;
  lastRecoveredAt: string | null;
  totalDowntimeSeconds: number;
  downCount: number;
  lastBackupAt: string | null;
  backupCount: number;
  maxBackupSizeMb: number | null;
  apiRateLimit: string | null;
  backupRateLimit: string | null;
  heartbeatRateLimit: string | null;
  createdAt: string;
  updatedAt: string;
  destination: { id: string; name: string; type: DestinationType; verified: boolean } | null;
  token: { prefix: string; createdAt: string; lastUsedAt: string | null } | null;
}

export interface HealthEvent {
  id: string;
  serviceId: string;
  serviceName?: string;
  eventType: 'OUTAGE';
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
}

export interface Destination {
  id: string;
  name: string;
  type: DestinationType;
  telegramChatId: number;
  telegramThreadId: number | null;
  verified: boolean;
  verifiedAt: string | null;
  createdAt: string;
  serviceCount: number;
}

export interface Backup {
  id: string;
  serviceId: string;
  serviceName: string;
  userId: string;
  filename: string;
  sizeBytes: number;
  status: BackupStatus;
  errorCode: string | null;
  errorMessage: string | null;
  destinationId: string | null;
  destinationName: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface Page<T> {
  items: T[];
  total: number;
}

export interface DashboardStats {
  totalServices: number;
  monitoredServices: number;
  healthyServices: number;
  downServices: number;
  recentBackups: number;
  successfulBackups: number;
  failedBackups: number;
  recentBackupBytes: number;
  periodDays: number;
}

export interface DefaultLimits {
  apiRateLimit: string;
  backupRateLimit: string;
  heartbeatRateLimit: string;
  serviceCreateRateLimit: string;
  maxBackupSizeMb: number;
  maxServicesPerUser: number;
}

export interface AdminUser {
  id: string;
  telegramId: number;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  role: 'USER' | 'ADMIN';
  blocked: boolean;
  blockedReason: string | null;
  maxServices: number | null;
  maxBackupSizeMb: number | null;
  apiRateLimit: string | null;
  backupRateLimit: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  isAdmin: boolean;
  isRootAdmin: boolean;
  serviceCount?: number;
}
