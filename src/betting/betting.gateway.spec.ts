import { Test, TestingModule } from '@nestjs/testing';
import { BettingGateway } from './betting.gateway';

describe('BettingGateway', () => {
  let gateway: BettingGateway;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [BettingGateway],
    }).compile();

    gateway = module.get<BettingGateway>(BettingGateway);
  });

  it('should be defined', () => {
    expect(gateway).toBeDefined();
  });
});
