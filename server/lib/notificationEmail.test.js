import { describe, it, expect } from 'vitest';
import { buildNotificationEmail, safeLink, shorten, stripLeadingEmoji } from './notificationEmail.js';

describe('buildNotificationEmail — artículo del blog', () => {
  const blog = {
    type: 'blog',
    title: '📰 Interés compuesto: cuánto pueden crecer 200 € al mes',
    message: '72.000 € aportados que se convierten en unos 244.000 € en 30 años. Ejemplos reales del efecto del tiempo, la rentabilidad y las comisiones, y una calculadora para probar tus números.',
    link: '/blog/interes-compuesto-aportaciones-mensuales',
  };
  const mail = buildNotificationEmail(blog);

  it('un solo emoji en el asunto (antes salía "🔔 📰 Título")', () => {
    expect(mail.subject).toBe('📰 Interés compuesto: cuánto pueden crecer 200 € al mes');
  });

  it('lleva un botón "Leer el artículo" que abre el artículo en example.com', () => {
    expect(mail.html).toContain('href="https://example.com/blog/interes-compuesto-aportaciones-mensuales"');
    expect(mail.html).toContain('Leer el artículo');
    expect(mail.html).toContain('Nuevo en el blog');
    expect(mail.text).toContain('https://example.com/blog/interes-compuesto-aportaciones-mensuales');
  });

  it('el resumen se recorta a un par de líneas', () => {
    expect(mail.text.split('\n\n')[1].length).toBeLessThanOrEqual(181);
    expect(mail.text.split('\n\n')[1].endsWith('…')).toBe(true);
  });
});

describe('buildNotificationEmail — otros avisos', () => {
  it('sin enlace, el botón lleva a la bandeja de notificaciones', () => {
    const mail = buildNotificationEmail({ type: 'dividend', title: 'AAPL paga dividendo mañana', message: 'Ex-dividendo el 10-oct.' });
    expect(mail.html).toContain('href="https://example.com/app/notificaciones"');
    expect(mail.subject).toBe('💰 AAPL paga dividendo mañana');
  });

  it('escapa el texto (títulos con nombres de broker o notas del usuario)', () => {
    const mail = buildNotificationEmail({ title: '<script>alert(1)</script>', message: 'a & b "c"' });
    expect(mail.html).not.toContain('<script>alert(1)</script>');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.html).toContain('a &amp; b');
  });

  it('el mensaje igual al título no se repite', () => {
    const mail = buildNotificationEmail({ title: 'Hola', message: 'Hola' });
    expect(mail.text).toBe('Hola\n\nAbrir Trazza: https://example.com/app/notificaciones');
  });
});

describe('safeLink — el botón nunca sale de example.com', () => {
  it('acepta rutas internas y URLs propias', () => {
    expect(safeLink('/blog/x')).toBe('https://example.com/blog/x');
    expect(safeLink('https://example.com/app')).toBe('https://example.com/app');
  });

  it('rechaza otros dominios, rutas de protocolo relativo y javascript:', () => {
    for (const bad of ['//evil.com/x', 'https://evil.com', 'javascript:alert(1)', 'https://example.com.evil.com/x', '/a b', '', null]) {
      expect(safeLink(bad)).toBe('https://example.com/app/notificaciones');
    }
  });
});

describe('utilidades de texto', () => {
  it('quita los emojis del principio, incluidos los compuestos', () => {
    expect(stripLeadingEmoji('📰 Título')).toBe('Título');
    expect(stripLeadingEmoji('⚠️ Ojo')).toBe('Ojo');
    expect(stripLeadingEmoji('Sin emoji')).toBe('Sin emoji');
  });

  it('recorta por palabra y no deja comas colgando', () => {
    expect(shorten('uno dos tres, cuatro cinco', 15)).toBe('uno dos tres…');
    expect(shorten('corto', 15)).toBe('corto');
  });
});

describe('buildNotificationEmail — tipo e idioma', () => {
  it('los resultados ya no llegan con la etiqueta de dividendos', () => {
    const mail = buildNotificationEmail({ type: 'earnings', title: '📅 Resultados próximos', message: 'META publica resultados en 7 días' });
    expect(mail.html).toContain('Resultados');
    expect(mail.html).not.toContain('Dividendos');
    expect(mail.subject.startsWith('📊')).toBe(true);
  });

  it('en inglés para un usuario en inglés', () => {
    const mail = buildNotificationEmail({ type: 'earnings', title: '📅 Upcoming earnings', message: 'META reports earnings in 7 days', lang: 'en' });
    expect(mail.html).toContain('lang="en"');
    expect(mail.html).toContain('Manage email notifications');
    expect(mail.text).toContain('View in Trazza');
  });
});
