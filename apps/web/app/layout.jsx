import './globals.css';
export const metadata = {
  title: 'Carsoo Remote Capture',
  description: 'Seller capture & admin review for Carsoo',
  manifest: '/manifest.webmanifest'
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <div className="nav">
          <a href="/">Carsoo Capture</a>
          <div>
            <a href="/admin">Admin</a>
          </div>
        </div>
        {children}
      </body>
    </html>
  );
}
