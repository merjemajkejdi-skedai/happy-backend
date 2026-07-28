-- CreateIndex
CREATE INDEX "orders_venue_id_business_date_idx" ON "orders"("venue_id", "business_date");

-- CreateIndex
CREATE INDEX "orders_venue_id_shift_id_idx" ON "orders"("venue_id", "shift_id");

-- CreateIndex
CREATE INDEX "payments_venue_id_shift_id_idx" ON "payments"("venue_id", "shift_id");
