import { getOAuthProviders as rootGetOAuthProviders, refreshOAuthToken as rootRefreshOAuthToken } from "@ngodeai/ai";
import {
	getOAuthProviders as oauthGetOAuthProviders,
	refreshOAuthToken as oauthRefreshOAuthToken,
} from "@ngodeai/ai/registry/oauth";
import "@ngodeai/ai/providers/anthropic";
import "@ngodeai/ai/auth-storage";

const publicExports = [rootGetOAuthProviders, rootRefreshOAuthToken, oauthGetOAuthProviders, oauthRefreshOAuthToken];

if (publicExports.some(value => !value)) {
	throw new Error("OAuth registry exports are unavailable");
}
