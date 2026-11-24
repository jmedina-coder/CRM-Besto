import type { Metadata } from 'next';
import '@fontsource-variable/inter';
import './globals.css';

export const metadata: Metadata = {
  title: 'BESTO OS | CRM Comercial',
  description: 'Espacio comercial de BESTO para gestionar oportunidades, seguimientos y clientes.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="es-CO"><body>{children}</body></html>;
}
