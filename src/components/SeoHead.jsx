import { Helmet } from 'react-helmet';
import { absoluteUrl, SITE_NAME, OG_IMAGE, structuredDataFor } from '@/lib/siteMeta';

/**
 * <head> de una página pública: título, descripción, canonical, Open Graph,
 * Twitter y JSON-LD. Los MISMOS datos los escribe `tools/generate-seo.js` en el
 * HTML estático al compilar (ver lib/siteMeta.js), así que el buscador ve lo
 * mismo con y sin JavaScript.
 *
 * `noindex` para lo que no debe salir en Google (la cartera compartida por
 * enlace es pública para quien tenga el enlace, no para el mundo).
 */
export default function SeoHead({ title, description, path = '/', type = 'website', schema = null, noindex = false, lang }) {
  const url = absoluteUrl(path);
  const ld = schema ? structuredDataFor(schema, { title, description, url }) : [];
  return (
    <Helmet>
      {lang && <html lang={lang} />}
      <title>{title}</title>
      {description && <meta name="description" content={description} />}
      {noindex
        ? <meta name="robots" content="noindex, nofollow" />
        : <link rel="canonical" href={url} />}
      <meta property="og:site_name" content={SITE_NAME} />
      <meta property="og:type" content={type} />
      <meta property="og:title" content={title} />
      {description && <meta property="og:description" content={description} />}
      <meta property="og:url" content={url} />
      <meta property="og:image" content={OG_IMAGE.url} />
      <meta property="og:image:width" content={String(OG_IMAGE.width)} />
      <meta property="og:image:height" content={String(OG_IMAGE.height)} />
      <meta property="og:image:alt" content={OG_IMAGE.alt} />
      <meta name="twitter:image" content={OG_IMAGE.url} />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={title} />
      {description && <meta name="twitter:description" content={description} />}
      {ld.map((obj, i) => (
        <script key={i} type="application/ld+json">{JSON.stringify(obj)}</script>
      ))}
    </Helmet>
  );
}
