export type Stage = 'new' | 'contacted' | 'scheduled' | 'proposal' | 'won' | 'lost';
export type SalesUserId = 'jhon' | 'pelos';
export type CrmUser = { id: SalesUserId; name: string; role: 'manager' | 'seller' };

export const SALES_USERS: CrmUser[] = [
  { id: 'jhon', name: 'Jhon', role: 'manager' },
  { id: 'pelos', name: 'Pelos', role: 'seller' },
];

export const STAGES: { id: Stage; label: string; color: string; description: string }[] = [
  { id: 'new', label: 'Nuevo', color: 'slate', description: 'Prospectos por contactar' },
  { id: 'contacted', label: 'Contactado', color: 'blue', description: 'Conversaciones iniciadas' },
  { id: 'scheduled', label: 'Agendado', color: 'violet', description: 'Visitas o demos acordadas' },
  { id: 'proposal', label: 'Propuesta', color: 'amber', description: 'Cotizaciones en seguimiento' },
  { id: 'won', label: 'Venta confirmada', color: 'green', description: 'Clientes de BESTO' },
  { id: 'lost', label: 'Perdido', color: 'rose', description: 'Oportunidades cerradas' },
];

export const SOURCES = ['Visita presencial', 'WhatsApp', 'Instagram', 'Facebook', 'Llamada', 'Referido', 'Sitio web', 'Otro'];
export type ActivityKind = 'note' | 'whatsapp' | 'call' | 'meeting' | 'email';
export type ActivityInput = { kind: ActivityKind; body: string; direction?: 'sent' | 'received' };
export type Activity = Omit<ActivityInput, 'kind'> & {
  id: string;
  kind: ActivityKind | 'stage' | 'created';
  createdAt: string;
  author?: SalesUserId;
};
export type LeadInput = {
  name: string;
  company: string;
  role: string;
  phone: string;
  email: string;
  source: string;
  tags: string[];
  amount: number | null;
  stage: Stage;
  assignee: SalesUserId;
  nextFollowUp: string | null;
  nextAction: string;
};
export type Lead = LeadInput & {
  id: string;
  createdAt: string;
  updatedAt: string;
  wonAt: string | null;
  revision: number;
  activities: Activity[];
};

export const TIME_ZONE = 'America/Bogota';
const pesos = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
const dateTime = new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: TIME_ZONE });
const dateOnly = new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeZone: TIME_ZONE });
const dayKey = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: TIME_ZONE });

export function formatMoney(amount: number | null) {
  return amount === null ? 'Sin valor' : pesos.format(amount);
}
export function formatDate(iso: string) {
  return dateTime.format(new Date(iso));
}
export function formatDay(iso: string) {
  return dateOnly.format(new Date(iso));
}
export function bogotaDay(date: Date | string) {
  return dayKey.format(new Date(date));
}
export function initials(text: string) {
  return text.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => Array.from(part)[0]).join('').toLocaleUpperCase('es-CO');
}
