// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: twitter-client-v1-initial
const MODULE_REVISION = 'twitter-client-v1-initial';
console.log(`[twitter-client] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

/**
 * Twitter API v2 Client
 *
 * Executes Twitter API calls with OAuth access token.
 * Token never leaves the control plane.
 *
 * Security: account_id is injected server-side by the gateway, never from the sandbox request.
 */

const TWITTER_API_BASE = 'https://api.twitter.com';

const TWEET_FIELDS = 'id,text,created_at,author_id,public_metrics,conversation_id';
const USER_FIELDS = 'name,username';
const EXPANSIONS = 'author_id';

interface TwitterTweet {
  id: string;
  text: string;
  created_at?: string;
  author_id?: string;
  public_metrics?: {
    retweet_count: number;
    reply_count: number;
    like_count: number;
    quote_count: number;
  };
  conversation_id?: string;
}

interface TwitterUser {
  id: string;
  name: string;
  username: string;
  description?: string;
  public_metrics?: {
    followers_count: number;
    following_count: number;
    tweet_count: number;
    listed_count: number;
  };
  profile_image_url?: string;
}

interface TwitterSearchResponse {
  data?: TwitterTweet[];
  includes?: { users?: TwitterUser[] };
  meta?: {
    newest_id?: string;
    oldest_id?: string;
    result_count?: number;
    next_token?: string;
  };
}

interface TwitterSingleTweetResponse {
  data?: TwitterTweet;
  includes?: { users?: TwitterUser[] };
}

interface TwitterUserResponse {
  data?: TwitterUser;
}

/**
 * Execute a Twitter action
 */
export async function executeTwitterAction(
  action: string,
  args: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  switch (action) {
    case 'twitter.search':
      return searchTweets(args, accessToken);
    case 'twitter.get_tweet':
      return getTweet(args, accessToken);
    case 'twitter.get_mentions':
      return getMentions(args, accessToken);
    case 'twitter.get_timeline':
      return getTimeline(args, accessToken);
    case 'twitter.get_user':
      return getUser(args, accessToken);
    case 'twitter.post':
      return postTweet(args, accessToken);
    case 'twitter.reply':
      return replyToTweet(args, accessToken);
    case 'twitter.like':
      return likeTweet(args, accessToken);
    case 'twitter.retweet':
      return retweet(args, accessToken);
    case 'twitter.follow':
      return followUser(args, accessToken);
    case 'twitter.delete_tweet':
      return deleteTweet(args, accessToken);
    default:
      throw new Error(`Unknown Twitter action: ${action}`);
  }
}

async function twitterFetch(
  path: string,
  accessToken: string,
  options?: RequestInit
): Promise<Response> {
  const response = await fetch(`${TWITTER_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Twitter API error: ${response.status} - ${error}`);
  }

  return response;
}

async function searchTweets(
  args: Record<string, unknown>,
  accessToken: string
): Promise<TwitterSearchResponse> {
  const query = args.query as string;
  if (!query) {
    throw new Error('query is required');
  }

  const maxResults = Math.min(Math.max(args.max_results as number || 10, 10), 100);

  const params = new URLSearchParams({
    query,
    max_results: maxResults.toString(),
    'tweet.fields': TWEET_FIELDS,
    expansions: EXPANSIONS,
    'user.fields': USER_FIELDS,
  });

  const response = await twitterFetch(`/2/tweets/search/recent?${params}`, accessToken);
  return response.json() as Promise<TwitterSearchResponse>;
}

async function getTweet(
  args: Record<string, unknown>,
  accessToken: string
): Promise<TwitterSingleTweetResponse> {
  const tweetId = args.tweet_id as string;
  if (!tweetId) {
    throw new Error('tweet_id is required');
  }

  const params = new URLSearchParams({
    'tweet.fields': TWEET_FIELDS,
    expansions: EXPANSIONS,
    'user.fields': USER_FIELDS,
  });

  const response = await twitterFetch(`/2/tweets/${tweetId}?${params}`, accessToken);
  return response.json() as Promise<TwitterSingleTweetResponse>;
}

async function getMentions(
  args: Record<string, unknown>,
  accessToken: string
): Promise<TwitterSearchResponse> {
  const accountId = args.account_id as string;
  if (!accountId) {
    throw new Error('account_id is required (injected server-side)');
  }

  const maxResults = Math.min(Math.max(args.max_results as number || 10, 10), 100);

  const params = new URLSearchParams({
    max_results: maxResults.toString(),
    'tweet.fields': TWEET_FIELDS,
    expansions: EXPANSIONS,
    'user.fields': USER_FIELDS,
  });

  const response = await twitterFetch(`/2/users/${accountId}/mentions?${params}`, accessToken);
  return response.json() as Promise<TwitterSearchResponse>;
}

async function getTimeline(
  args: Record<string, unknown>,
  accessToken: string
): Promise<TwitterSearchResponse> {
  const accountId = args.account_id as string;
  if (!accountId) {
    throw new Error('account_id is required (injected server-side)');
  }

  const maxResults = Math.min(Math.max(args.max_results as number || 10, 10), 100);

  const params = new URLSearchParams({
    max_results: maxResults.toString(),
    'tweet.fields': TWEET_FIELDS,
    expansions: EXPANSIONS,
    'user.fields': USER_FIELDS,
  });

  const response = await twitterFetch(`/2/users/${accountId}/tweets?${params}`, accessToken);
  return response.json() as Promise<TwitterSearchResponse>;
}

async function getUser(
  args: Record<string, unknown>,
  accessToken: string
): Promise<TwitterUserResponse> {
  const userId = args.user_id as string | undefined;
  const username = args.username as string | undefined;

  if (!userId && !username) {
    throw new Error('Either user_id or username is required');
  }

  const userFields = 'id,name,username,description,public_metrics,profile_image_url';

  let path: string;
  if (userId) {
    const params = new URLSearchParams({ 'user.fields': userFields });
    path = `/2/users/${userId}?${params}`;
  } else {
    const params = new URLSearchParams({ 'user.fields': userFields });
    path = `/2/users/by/username/${username}?${params}`;
  }

  const response = await twitterFetch(path, accessToken);
  return response.json() as Promise<TwitterUserResponse>;
}

async function postTweet(
  args: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  const text = args.text as string;
  if (!text) {
    throw new Error('text is required');
  }

  const response = await twitterFetch('/2/tweets', accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });

  return response.json();
}

async function replyToTweet(
  args: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  const text = args.text as string;
  const tweetId = args.tweet_id as string;
  if (!text) {
    throw new Error('text is required');
  }
  if (!tweetId) {
    throw new Error('tweet_id is required');
  }

  const response = await twitterFetch('/2/tweets', accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      reply: { in_reply_to_tweet_id: tweetId },
    }),
  });

  return response.json();
}

async function likeTweet(
  args: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  const accountId = args.account_id as string;
  const tweetId = args.tweet_id as string;
  if (!accountId) {
    throw new Error('account_id is required (injected server-side)');
  }
  if (!tweetId) {
    throw new Error('tweet_id is required');
  }

  const response = await twitterFetch(`/2/users/${accountId}/likes`, accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tweet_id: tweetId }),
  });

  return response.json();
}

async function retweet(
  args: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  const accountId = args.account_id as string;
  const tweetId = args.tweet_id as string;
  if (!accountId) {
    throw new Error('account_id is required (injected server-side)');
  }
  if (!tweetId) {
    throw new Error('tweet_id is required');
  }

  const response = await twitterFetch(`/2/users/${accountId}/retweets`, accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tweet_id: tweetId }),
  });

  return response.json();
}

async function followUser(
  args: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  const accountId = args.account_id as string;
  const targetUserId = args.target_user_id as string;
  if (!accountId) {
    throw new Error('account_id is required (injected server-side)');
  }
  if (!targetUserId) {
    throw new Error('target_user_id is required');
  }

  const response = await twitterFetch(`/2/users/${accountId}/following`, accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target_user_id: targetUserId }),
  });

  return response.json();
}

async function deleteTweet(
  args: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  const tweetId = args.tweet_id as string;
  if (!tweetId) {
    throw new Error('tweet_id is required');
  }

  const response = await twitterFetch(`/2/tweets/${tweetId}`, accessToken, {
    method: 'DELETE',
  });

  return response.json();
}
