// Latest desktop release, proxied + cached from GitHub Releases.
//
// Public endpoint (no auth) that powers the on-site /download page, so users see
// the release notes + download links without leaving orcabot.com. Responses are
// edge-cached (cacheTtl) so we barely touch the GitHub API and never hit its
// unauthenticated rate limit, even under traffic.

const RELEASES_REPO = 'Hyper-Int/OrcaBot';
const GITHUB_LATEST = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;

export interface ReleaseAsset {
  name: string;
  size: number;
  downloadUrl: string;
  contentType: string;
  downloadCount: number;
}

export interface LatestRelease {
  version: string;
  name: string;
  notes: string;
  htmlUrl: string;
  publishedAt: string;
  assets: ReleaseAsset[];
}

export async function getLatest(): Promise<Response> {
  try {
    const resp = await fetch(GITHUB_LATEST, {
      headers: {
        // GitHub rejects API requests without a User-Agent.
        'User-Agent': 'orcabot-controlplane',
        Accept: 'application/vnd.github+json',
      },
      // Cache at the edge so repeated page loads don't re-hit GitHub.
      cf: { cacheTtl: 300, cacheEverything: true },
    });

    if (!resp.ok) {
      return Response.json(
        { error: `GitHub returned ${resp.status}` },
        { status: 502, headers: { 'Cache-Control': 'public, max-age=60' } }
      );
    }

    const gh = (await resp.json()) as {
      tag_name?: string;
      name?: string;
      body?: string;
      html_url?: string;
      published_at?: string;
      assets?: Array<{
        name: string;
        size: number;
        browser_download_url: string;
        content_type: string;
        download_count: number;
      }>;
    };

    const release: LatestRelease = {
      version: (gh.tag_name || '').replace(/^v/, ''),
      name: gh.name || gh.tag_name || '',
      notes: gh.body || '',
      htmlUrl: gh.html_url || `https://github.com/${RELEASES_REPO}/releases/latest`,
      publishedAt: gh.published_at || '',
      assets: (gh.assets || []).map((a) => ({
        name: a.name,
        size: a.size,
        downloadUrl: a.browser_download_url,
        contentType: a.content_type,
        downloadCount: a.download_count,
      })),
    };

    return Response.json(release, {
      headers: { 'Cache-Control': 'public, max-age=300' },
    });
  } catch {
    return Response.json(
      { error: 'Failed to fetch latest release' },
      { status: 502 }
    );
  }
}
