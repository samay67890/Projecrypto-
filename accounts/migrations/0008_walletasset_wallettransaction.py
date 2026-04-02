from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('accounts', '0007_trade_event_type_trade_market_type'),
    ]

    operations = [
        migrations.CreateModel(
            name='WalletAsset',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('symbol', models.CharField(max_length=20)),
                ('balance', models.DecimalField(decimal_places=8, default=0.0, max_digits=30)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('wallet', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='assets', to='accounts.wallet')),
            ],
            options={
                'ordering': ['symbol'],
                'unique_together': {('wallet', 'symbol')},
            },
        ),
        migrations.CreateModel(
            name='WalletTransaction',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('reference', models.CharField(max_length=64, unique=True)),
                ('tx_type', models.CharField(choices=[('deposit', 'Deposit'), ('withdrawal', 'Withdrawal')], max_length=20)),
                ('asset', models.CharField(default='USDT', max_length=20)),
                ('amount', models.DecimalField(decimal_places=8, max_digits=30)),
                ('method', models.CharField(blank=True, default='', max_length=120)),
                ('status', models.CharField(default='completed', max_length=30)),
                ('details', models.CharField(blank=True, default='', max_length=255)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='wallet_transactions', to='accounts.user')),
                ('wallet', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='transactions', to='accounts.wallet')),
            ],
            options={
                'ordering': ['-created_at'],
            },
        ),
        migrations.AddIndex(
            model_name='wallettransaction',
            index=models.Index(fields=['user', 'created_at'], name='accounts_wa_user_id_b95156_idx'),
        ),
        migrations.AddIndex(
            model_name='wallettransaction',
            index=models.Index(fields=['wallet', 'created_at'], name='accounts_wa_wallet__24e6b6_idx'),
        ),
    ]
