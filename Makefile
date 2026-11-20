.PHONY: local-env redis-up up down install build load check openapi

local-env:
	node scripts/local-env.mjs

install:
	corepack pnpm install --frozen-lockfile

build:
	corepack pnpm build

redis-up: local-env
	docker compose up -d --wait redis

up: local-env build
	docker compose --profile runtime up -d --wait

down:
	docker compose --profile runtime down

load: build
	node --env-file=.env dist/scripts/load-library.js

check:
	corepack pnpm lint
	corepack pnpm typecheck
	corepack pnpm test

openapi: build
	corepack pnpm openapi
