import { Entity, ObjectIdColumn, Column, CreateDateColumn } from 'typeorm';
import { ObjectId } from 'mongodb';

@Entity('final_trades_to_be_placed')
export class FinalTradeToBePlacedEntity {
  @ObjectIdColumn()
  _id: ObjectId;

  // --- Source Signal ---
  @Column()
  sourceSignalId: ObjectId;

  @Column()
  strategyName: string;

  // --- Trade Details ---
  @Column()
  exchange: string;

  @Column()
  symbol: string;

  @Column()
  token: string;

  @Column()
  side: 'BUY' | 'SELL';

  @Column()
  quantityLots: number;

  @Column()
  productType: string;

  // --- Multi-leg support ---
  @Column()
  legNumber: number;

  @Column()
  totalLegs: number;

  @Column({ default: 0 })
  retryCount?: number;

  @Column({ nullable: true })
  lastRetryAt?: Date;

  // --- Status Tracking ---
  @Column({ default: 'PENDING' })
  tradeStatus: 'PENDING' | 'PLACED' | 'FAILED';

  // --- Day-wise segregation ---
  @Column()
  tradeDate: string; // YYYY-MM-DD (IST)

  @CreateDateColumn()
  createdAt: Date;
}
