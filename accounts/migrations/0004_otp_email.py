# Generated manually to add email field and make user nullable

from django.db import migrations, models
import django.db.models.deletion


def populate_email_from_user(apps, schema_editor):
    """Populate email field from user.email for existing OTP records."""
    OTP = apps.get_model('accounts', 'OTP')
    for otp in OTP.objects.filter(user__isnull=False):
        otp.email = otp.user.email
        otp.save()


def reverse_populate_email(apps, schema_editor):
    """Reverse migration - nothing to do."""
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('accounts', '0003_alter_user_date_joined_alter_user_first_name_and_more'),
    ]

    operations = [
        # Step 1: Add email field as nullable
        migrations.AddField(
            model_name='otp',
            name='email',
            field=models.EmailField(help_text='Email address this OTP is sent to (used before user creation)', null=True, blank=True),
        ),
        # Step 2: Populate email from user.email for existing records
        migrations.RunPython(populate_email_from_user, reverse_populate_email),
        # Step 3: Make email non-nullable
        migrations.AlterField(
            model_name='otp',
            name='email',
            field=models.EmailField(help_text='Email address this OTP is sent to (used before user creation)'),
        ),
        # Step 4: Make user nullable
        migrations.AlterField(
            model_name='otp',
            name='user',
            field=models.ForeignKey(
                blank=True,
                help_text='User this OTP belongs to (null until account is created)',
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name='otps',
                to='accounts.user',
            ),
        ),
        # Step 5: Add index for email
        migrations.AddIndex(
            model_name='otp',
            index=models.Index(fields=['email', 'expires_at'], name='accounts_ot_email_123abc_idx'),
        ),
    ]
