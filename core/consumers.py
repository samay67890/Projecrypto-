import asyncio
import json

import requests
from channels.generic.websocket import AsyncWebsocketConsumer


class MarketConsumer(AsyncWebsocketConsumer):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.symbol = "BTCUSDT"
        self._tasks = []

    async def connect(self):
        await self.accept()
        self._tasks = [
            asyncio.create_task(self._price_loop()),
            asyncio.create_task(self._orderbook_loop()),
        ]
        await self.send(text_data=json.dumps({
            "type": "connected",
            "symbol": self.symbol,
            "message": "market socket connected",
        }))

    async def disconnect(self, close_code):
        for task in self._tasks:
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)

    async def receive(self, text_data=None, bytes_data=None):
        if not text_data:
            return
        try:
            payload = json.loads(text_data)
        except json.JSONDecodeError:
            await self.send(text_data=json.dumps({"type": "error", "message": "invalid_json"}))
            return

        message_type = str(payload.get("type", "")).lower()
        if message_type == "ping":
            await self.send(text_data=json.dumps({"type": "pong"}))
            return

        if message_type == "subscribe":
            symbol = str(payload.get("symbol", "")).upper().strip()
            if not symbol.endswith("USDT"):
                await self.send(text_data=json.dumps({"type": "error", "message": "symbol_must_end_with_usdt"}))
                return
            self.symbol = symbol
            await self.send(text_data=json.dumps({"type": "subscribed", "symbol": self.symbol}))
            return

        await self.send(text_data=json.dumps({"type": "error", "message": "unknown_message_type"}))

    async def _price_loop(self):
        while True:
            payload = await asyncio.to_thread(self._fetch_price)
            if payload:
                await self.send(text_data=json.dumps({"type": "price", **payload}))
            await asyncio.sleep(1)

    async def _orderbook_loop(self):
        while True:
            payload = await asyncio.to_thread(self._fetch_orderbook)
            if payload:
                await self.send(text_data=json.dumps({"type": "orderbook", "data": payload}))
            await asyncio.sleep(2)

    def _fetch_price(self):
        try:
            resp = requests.get(
                "https://api.binance.com/api/v3/ticker/24hr",
                params={"symbol": self.symbol},
                timeout=8,
            )
            data = resp.json() if resp.ok else {}
            return {
                "symbol": self.symbol,
                "price": float(data.get("lastPrice", 0) or 0),
                "change": float(data.get("priceChangePercent", 0) or 0),
                "high": float(data.get("highPrice", 0) or 0),
                "low": float(data.get("lowPrice", 0) or 0),
                "volume": float(data.get("volume", 0) or 0),
                "quoteVolume": float(data.get("quoteVolume", 0) or 0),
            }
        except Exception:
            return None

    def _fetch_orderbook(self):
        try:
            resp = requests.get(
                "https://api.binance.com/api/v3/depth",
                params={"symbol": self.symbol, "limit": 20},
                timeout=8,
            )
            data = resp.json() if resp.ok else {}
            return {
                "symbol": self.symbol,
                "asks": data.get("asks", []),
                "bids": data.get("bids", []),
            }
        except Exception:
            return None
