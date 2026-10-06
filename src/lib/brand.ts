/** Public brand copy. Venue is configurable; organisation is fixed for this deployment. */
export const ORGANISATION = 'Samatat Sanskriti';
export const ORGANISATION_BN = 'সমতট সংস্কৃতি';
export const FESTIVAL = 'Samatat Natyomela 2026';
export const FESTIVAL_BN = 'সমতট নাট্যমেলা ২০২৬';
/** Festival window (tentative programme). */
export const FESTIVAL_DATES = '19–30 December 2026';
export const FESTIVAL_DATES_BN = '১৯–৩০ ডিসেম্বর ২০২৬';
/** Default venue label — may be changed by committee without renaming the organisation. */
export const DEFAULT_VENUE = 'Ganabhawan';
export const DEFAULT_VENUE_BN = 'গণভবন';
export const DEFAULT_VENUE_PLACE = 'Uttarpara';
export const DEFAULT_VENUE_PLACE_BN = 'উত্তরপাড়া';
export const FESTIVAL_SHORT = FESTIVAL;
export const SITE_TITLE = `${FESTIVAL_BN} · ${DEFAULT_VENUE}`;
export const SITE_DESCRIPTION = `${FESTIVAL} (${FESTIVAL_DATES}) at ${DEFAULT_VENUE}, ${DEFAULT_VENUE_PLACE}. Presented by ${ORGANISATION}.`;
export const SOURCE_SITE = 'https://samatat.org';
/** Hall photo taken from the stage looking at the audience (ground + first floor). */
export const AUDITORIUM_PHOTO = '/images/auditorium-two-floors.jpg';
export const BRAND_LOGO = '/images/samatat/logo.png';
export const STORY_PHOTO = '/images/samatat/story-swapnomoy.jpg';
/** Festival announcement hero for the 2026 Natyomela. */
export const HERO_PHOTO = '/images/samatat/hero-natyomela-2026.jpg';
/** Production posters and stills used when a show has no dedicated artwork. */
export const STAGE_PHOTOS = [
  '/images/samatat/shows/macbeth-two.jpg',
  '/images/samatat/shows/goraibabu.jpg',
  '/images/samatat/shows/asakti.jpg',
  '/images/samatat/shows/pratham-partha.png',
  '/images/samatat/shows/kirtankhola.jpg',
  '/images/samatat/shows/angina-jure-bhor.jpg',
  '/images/samatat/shows/jatra-gopal.jpg',
  '/images/samatat/shows/samatat-double-bill.jpg',
  '/images/samatat/shows/macbeth-two-still.jpg',
  '/images/samatat/shows/asakti-still.jpg',
] as const;
