import asyncio
import json

import requests
from channels.generic.websocket import AsyncWebsocketConsumer


class MarketConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        await self.accept()
        self._tasks = [
            asyncio.create_task(self._price_loop()),
            asyncio.create_task(self._orderbook_loop()),
        ]

    async def disconnect(self, close_code):
        for task in getattr(self, "_tasks", []):
            task.cancel()

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
            resp = requests.get("http://127.0.0.1:8000/api/ticker/", timeout=8)
            data = resp.json()
            return {
                "price": data.get("price"),
                "change": data.get("change"),
                "high": data.get("high"),
                "low": data.get("low"),
                "volume": data.get("volume"),
                "quoteVolume": data.get("quoteVolume"),
            }
        except Exception:
            return None

    def _fetch_orderbook(self):
        try:
            resp = requests.get("http://127.0.0.1:8000/api/orderbook/", timeout=8)
            return resp.json()
        except Exception:
            return None
