---
type: page
code: false
title: Request | Framework | Core

description: KuzzleRequest events list
order: 100
---

# KuzzleRequest Events

## request:onAuthorized

| Arguments | Type                                                           | Description                |
| --------- | -------------------------------------------------------------- | -------------------------- |
| `request` | <pre><a href=/core/2/framework/classes/kuzzle-request/properties>KuzzleRequest</a></pre> | The normalized API request |

Triggered whenever a request passes authorization checks and is ready to be processed.

This event occurs before [before events](/core/2/framework/events/api#before).

## request:onError

| Arguments | Type                                                           | Description                |
| --------- | -------------------------------------------------------------- | -------------------------- |
| `request` | <pre><a href=/core/2/framework/classes/kuzzle-request/properties>KuzzleRequest</a></pre> | The normalized API request |

Triggered whenever a request execution fails.

This event occurs after [error events](/core/2/framework/events/api#error).

## request:onSuccess

| Arguments | Type                                                           | Description                |
| --------- | -------------------------------------------------------------- | -------------------------- |
| `request` | <pre><a href=/core/2/framework/classes/kuzzle-request/properties>KuzzleRequest</a></pre> | The normalized API request |

Triggered whenever a request execution succeeds.

This event occurs after [after events](/core/2/framework/events/api#after).

## request:onUnauthorized

| Arguments | Type                                                           | Description                |
| --------- | -------------------------------------------------------------- | -------------------------- |
| `request` | <pre><a href=/core/2/framework/classes/kuzzle-request/properties>KuzzleRequest</a></pre> | The normalized API request |

Triggered whenever a request fails authorization checks, and is about to be rejected with a `401` error code.
